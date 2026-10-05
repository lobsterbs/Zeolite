/* Engine selection + ESM glue transform tests for the transport seam
   (issue #64). The seam keeps the libcurl path byte-identical; these
   cover the new pure surface only. */

import { describe, it, expect } from "vitest";
import { setEngine, currentEngine, stripEsmExports, inlineDataImports, reset, isConnectClassError, reconnectDelay, installWispWatcher } from "../libcurl-transport-vendored";

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
    expect(isConnectClassError(new TypeError("Request failed with error code 55: Failed sending data to the peer"))).toBe(true);
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
