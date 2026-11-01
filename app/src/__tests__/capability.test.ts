import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #544: the zl:ping capability report. A host or page must be able to
   tell "unavailable by design" from "broken" without reading engine
   internals, so the reply carries a compact factual object: the live
   page-socket transport, the #525 plaintext pass-through, the constant
   WebRTC unavailability (RTCPeerConnection is deleted by the navguard,
   pinned by navguard.test.ts) and the live replay-spool
   authorization. The control-plane mocks mirror control.test.ts: the
   vendored transport is a browser artifact and the bridge wiring is
   not under test here. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {} },
  altRegister: () => {},
  altConfigured: () => false,
}));

vi.mock("../ws-runtime", () => ({
  wsBridge: { open: () => {}, closeAll: () => {} },
  wsRelayBridge: { open: () => {}, closeAll: () => {} },
}));

/* The ping path never calls into the request engine, and the real
   module pulls the wasm-glue transform import that is absent in this
   environment (the same reason control.test.ts cannot collect here):
   stub the surface control.ts names instead. */
vi.mock("../request", () => ({
  ghosteryListFetch: async () => null,
  pageCacheClear: async () => {},
  virtualHcaptchaFrameFragment: (dest: string) => dest,
}));

import { handleControlEvent, type ControlMessage } from "../control";
import { relayRegister } from "../relayfetch";
import { setSpoolUploads, spoolUploadsEnabled } from "../swstate";

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

const mkEvent = (sourceUrl: string, msg: ControlMessage) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

describe("zl:ping capability report (#544)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSpoolUploads(false);
  });

  async function ping() {
    const { ev, posted } = mkEvent("https://w.example.org/j/token", { type: "zl:ping" });
    await handleControlEvent(ev, deps);
    expect(posted).toHaveLength(1);
    return posted[0] as {
      ok: boolean;
      capabilities: {
        websocket: string;
        websocketPlaintext: boolean;
        webrtc: string;
        replaySpool: boolean;
      };
    };
  }

  it("reports the native bridge, the plaintext pass-through and webrtc unavailability", async () => {
    const reply = await ping();
    expect(reply.ok).toBe(true);
    expect(reply.capabilities).toEqual({
      websocket: "native-bridge",
      websocketPlaintext: true,
      webrtc: "unavailable",
      replaySpool: spoolUploadsEnabled(),
    });
  });

  it("names the relay arm once an embedder channel is registered", async () => {
    /* A bare port-like object is all relayRegister keeps; nothing is
       sent on it during a ping. */
    relayRegister({ onmessage: null } as unknown as MessagePort);
    const reply = await ping();
    expect(reply.capabilities.websocket).toBe("relay");
    expect(reply.capabilities.webrtc).toBe("unavailable");
  });

  it("echoes the live spool authorization and never invents a capability", async () => {
    const before = await ping();
    expect(before.capabilities.replaySpool).toBe(spoolUploadsEnabled());
    setSpoolUploads(true);
    const after = await ping();
    expect(after.capabilities.replaySpool).toBe(true);
    /* The factual fields are closed vocabulary: only the two documented
       websocket values and the constant webrtc string. */
    expect(["native-bridge", "relay"]).toContain(after.capabilities.websocket);
    expect(after.capabilities.webrtc).toBe("unavailable");
    expect(after.capabilities.websocketPlaintext).toBe(true);
  });
});
