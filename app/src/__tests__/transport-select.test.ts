/* Engine selection + ESM glue transform tests for the transport seam
   (issue #64). The seam keeps the libcurl path byte-identical; these
   cover the new pure surface only. */

import { afterEach, describe, it, expect } from "vitest";
import { setEngine, currentEngine, stripEsmExports, inlineDataImports, reset, isConnectClassError, reconnectDelay, installWispWatcher, bustWispUrl } from "../libcurl-transport-vendored";
import { setTransportState, onTransportState, transportState, waitForTransportState } from "../transport-lifecycle";

describe("transport engine selection", () => {
  it("defaults to libcurl", () => {
    expect(currentEngine()).toBe("libcurl");
  });

  it("setEngine/currentEngine round-trip", () => {
    try {
      setEngine("epoxy");
      expect(currentEngine()).toBe("epoxy");
      setEngine("libcurl");
      expect(currentEngine()).toBe("libcurl");
    } finally {
      setEngine("libcurl");
    }
  });

  it("rejects unknown engines honestly", () => {
    expect(() => setEngine("winsock" as never)).toThrow(/unknown transport engine/);
  });
});

describe("stripEsmExports (epoxy glue loader)", () => {
  const src = [
    "export class A { constructor() { this.x = 1; } }",
    "export default function __wbg_init(p) { return p; }",
    "export const info = { v: 1 };",
    "const wasmUrl = new URL('epoxy.wasm', import.meta.url);",
    "export { A };",
  ].join("\n");

  it("strips every export statement and pins import.meta.url", () => {
    const out = stripEsmExports(src, "https://e.example/epoxy.wasm");
    expect(out).not.toMatch(/\bexport\b/);
    expect(out).toContain('"https://e.example/epoxy.wasm"');
    expect(out).not.toContain("import.meta");
  });

  it("produces an evaluable body with the expected bindings", () => {
    const out = stripEsmExports(src, "https://e.example/epoxy.wasm");
    const factory = new Function(out + "\nreturn { A, init: __wbg_init, info };");
    const m = factory() as { A: new () => { x: number }; init: (p: string) => string; info: { v: number } };
    expect(new m.A().x).toBe(1);
    expect(m.init("ok")).toBe("ok");
    expect(m.info.v).toBe(1);
  });
});

describe("inlineDataImports (epoxy glue loader)", () => {
  const helper = "export function ws_key() { return 'k'; }\nexport const tag = 7;\n";
  const src = [
    "import { ws_key, tag } from 'data:text/javascript;base64," + btoa(helper) + "';",
    "const used = ws_key();",
  ].join("\n");

  it("splices the decoded data: module in place of the import statement", () => {
    const out = stripEsmExports(inlineDataImports(src), "https://e.example/epoxy.wasm");
    expect(out).not.toMatch(/\bimport\b/);
    expect(out).not.toMatch(/\bexport\b/);
    const factory = new Function(out + "\nreturn { ws_key, tag, used };");
    const m = factory() as { ws_key: () => string; tag: number; used: string };
    expect(m.ws_key()).toBe("k");
    expect(m.tag).toBe(7);
    expect(m.used).toBe("k");
  });
});

/* Issue #74: connect-class detection and singleton reset. */
describe("transport reset (#74)", () => {
  it("classifies wisp-connect failures as connect-class", () => {
    expect(isConnectClassError("Wisp WebSocket failed to connect: websocket did not open")).toBe(true);
    expect(isConnectClassError("Request failed with error code 55: Failed sending data to the peer")).toBe(true);
    expect(isConnectClassError("Request failed with error code 56: Failure when receiving data from the peer")).toBe(true);
    expect(isConnectClassError("Request failed with error code 52: Server returned nothing (no headers, no data)")).toBe(true);
    expect(isConnectClassError(new TypeError("Request failed with error code 55: Failed sending data to the peer"))).toBe(true);
    // #133: throttled wisp streams surface as error 35, the wedged
    // socket afterwards as error 7 (local MAX_STREAMS_PER_CONNECTION=3 rig).
    expect(isConnectClassError("Request failed with error code 35: SSL connect error")).toBe(true);
    expect(isConnectClassError("Request failed with error code 7: Could not connect to server")).toBe(true);
    expect(isConnectClassError("Request failed with error code 75: unassigned")).toBe(false);
    expect(isConnectClassError("Request failed with error code 6: Could not resolve host")).toBe(false);
    expect(isConnectClassError("Request failed with error code 3: URL using bad format")).toBe(false);
  });

  it("leaves ordinary failures alone", () => {
    expect(isConnectClassError("TypeError: Failed to fetch")).toBe(false);
    expect(isConnectClassError(undefined)).toBe(false);
    expect(isConnectClassError(null)).toBe(false);
  });

  it("reset() never throws and leaves the engine selection intact", () => {
    setEngine("libcurl");
    expect(() => reset()).not.toThrow();
    expect(currentEngine()).toBe("libcurl");
  });
});

/* #133: wisp connection-cache key bust (wedged-transport heal). */
describe("wisp url bust (#133)", () => {
  it("generation 0 rides the pristine URL (first init unchanged)", () => {
    expect(bustWispUrl("wss://e.example/wisp/", 0)).toBe("wss://e.example/wisp/");
    expect(bustWispUrl("wss://e.example/wisp/", -1)).toBe("wss://e.example/wisp/");
  });

  it("busts the cache key per generation without moving the pathname", () => {
    const base = "wss://e.example/wisp/";
    const g1 = bustWispUrl(base, 1);
    const g2 = bustWispUrl(base, 2);
    expect(g1).toBe("wss://e.example/wisp/?zlG=1/");
    expect(g1).not.toBe(g2);
    /* the watcher matches origin+pathname: the bust must not break it */
    expect(new URL(g1).pathname).toBe(new URL(base).pathname);
  });

  it("normalizes a missing trailing slash and joins an existing query", () => {
    expect(bustWispUrl("wss://e.example/wisp", 3)).toBe("wss://e.example/wisp/?zlG=3/");
    expect(bustWispUrl("wss://e.example/wisp/?a=1", 4)).toBe("wss://e.example/wisp/?a=1/&zlG=4/");
  });
});

/* Issue #74 follow-up: wisp socket lifecycle watcher. */
describe("wisp socket watcher (#74 follow-up)", () => {
  it("reconnectDelay: 1s doubling, 60s ceiling, negatives clamp", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(2)).toBe(4000);
    expect(reconnectDelay(10)).toBe(60000);
    expect(reconnectDelay(-3)).toBe(1000);
  });

  it("installWispWatcher: no-op without WebSocket, idempotent with it", () => {
    expect(() => installWispWatcher({})).not.toThrow();
    class FakeWS {
      listeners: Record<string, Array<() => void>> = {};
      addEventListener(ev: string, fn: () => void) {
        (this.listeners[ev] ??= []).push(fn);
      }
      fire(ev: string) {
        (this.listeners[ev] ?? []).forEach((f) => f());
      }
    }
    const g: any = { WebSocket: FakeWS, location: { href: "https://sw.example/" } };
    installWispWatcher(g);
    const wrapped = g.WebSocket;
    installWispWatcher(g);
    expect(g.WebSocket).toBe(wrapped);
    /* A socket that is not the wisp endpoint (no lastCfg was ever set)
       must close without exploding or scheduling anything. */
    const ws = new g.WebSocket("wss://other.example/ws");
    ws.fire("close");
  });
});

/* Issue #119: explicit transport lifecycle machine. The vendored layer
   drives it (init/reset/watcher glue, live-verified); these gate the
   pure surface: transitions, event emission, and the bounded
   wait-for-reconnect path. */
describe("transport lifecycle (#119)", () => {
  afterEach(() => setTransportState("idle", "test cleanup"));

  it("emits on every real transition, not on same-state calls", () => {
    const seen: string[] = [];
    const off = onTransportState((s) => seen.push(s));
    setTransportState("connecting", "t");
    setTransportState("connecting", "t2"); /* same-state no-op */
    setTransportState("connected", "t3");
    off();
    setTransportState("dead", "t4"); /* unsubscribed: no emit */
    expect(seen).toEqual(["connecting", "connected"]);
    expect(transportState()).toBe("dead");
  });

  it("reset() transitions a live transport to dead", () => {
    setTransportState("connected", "t");
    reset();
    expect(transportState()).toBe("dead");
  });

  it("reset() of a never-initialized transport stays idle (idle is not dead)", () => {
    setTransportState("idle", "t");
    reset();
    expect(transportState()).toBe("idle");
  });

  it("waitForTransportState resolves true when the state arrives in time", async () => {
    setTransportState("dead", "t");
    const p = waitForTransportState("connected", 5_000);
    setTimeout(() => setTransportState("connected", "t"), 10);
    expect(await p).toBe(true);
  });

  it("waitForTransportState is bounded: false on timeout, never a hang", async () => {
    setTransportState("dead", "t");
    expect(await waitForTransportState("connected", 5)).toBe(false);
  });
});
