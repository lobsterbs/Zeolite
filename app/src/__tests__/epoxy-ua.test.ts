/* 2026-11-22 (#708 follow-up): the accepted zl:fingerprint profile must
   own the epoxy transport's wire-default UA. Before the fix the engine
   never passed any UA to EpoxyClientOptions, so epoxy shipped its
   built-in X11 Linux Chrome on requests without a user-agent header
   and on the wisp WS handshake, contradicting the spoofed profile. */

vi.mock("../request", () => ({
  ghosteryListFetch: async () => null,
  pageCacheClear: async () => {},
  virtualHcaptchaFrameFragment: (dest: string) => dest,
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleControlEvent, type ControlMessage } from "../control";
import { epoxyUserAgentValue, setEpoxyUserAgent } from "../libcurl-transport-vendored";

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const mkEvent = (msg: ControlMessage) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: "https://w.example.org/", id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

beforeEach(() => {
  vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  setEpoxyUserAgent("");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("zl:fingerprint wires the epoxy wire-default UA", () => {
  it("arms the UA from an accepted profile", async () => {
    const { ev, posted } = mkEvent({ type: "zl:fingerprint", profile: { userAgent: MAC_UA } });
    await handleControlEvent(ev, deps);
    expect(posted[0]).toMatchObject({ ok: true });
    expect(epoxyUserAgentValue()).toBe(MAC_UA);
  });

  it("re-arms on a profile change and clears on native restore", async () => {
    await handleControlEvent(mkEvent({ type: "zl:fingerprint", profile: { userAgent: MAC_UA } }).ev, deps);
    await handleControlEvent(mkEvent({ type: "zl:fingerprint", profile: { userAgent: WIN_UA } }).ev, deps);
    expect(epoxyUserAgentValue()).toBe(WIN_UA);
    await handleControlEvent(mkEvent({ type: "zl:fingerprint", profile: null }).ev, deps);
    expect(epoxyUserAgentValue()).toBe("");
  });

  it("keeps the current default when the profile is rejected", async () => {
    await handleControlEvent(mkEvent({ type: "zl:fingerprint", profile: { userAgent: MAC_UA } }).ev, deps);
    /* engineBindingError: a profile whose platform contradicts the live
       engine class must not silently rewire the transport default. */
    await handleControlEvent(mkEvent({ type: "zl:fingerprint", profile: { userAgent: "not a ua" } }).ev, deps);
    expect(epoxyUserAgentValue()).toBe(MAC_UA);
  });
});

describe("setEpoxyUserAgent state seam", () => {
  it("ignores non-string input and treats an empty string as the built-in default", () => {
    setEpoxyUserAgent(undefined);
    expect(epoxyUserAgentValue()).toBe("");
    (setEpoxyUserAgent as (v: unknown) => void)({ wss: 1 });
    expect(epoxyUserAgentValue()).toBe("");
  });
});