import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #87: the shared service-worker runtime state moved out of sw.ts;
   these tests pin the accessor surface the request engine and the
   control plane depend on. The transport seam is mocked to the engine
   name it reports in production: the vendored libcurl bundle is a
   browser/wasm artifact, and these tests exercise state, not transport. */
vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
}));

import { DEFAULT_PROFILE } from "../fingerprint";
import { DownloadTracker } from "../downloads";
import {
  DL,
  VCTX,
  getEngineDegraded,
  getFpProfile,
  getFpScript,
  getFpWorkerScript,
  getRouteKey,
  isHttpsUpgrade,
  navHandlesEnabled,
  pushDocCookieView,
  registerDocCookiePort,
  setEngineDegraded,
  setFingerprint,
  setHttpsUpgrade,
  setNavHandles,
  setRouteKey,
  setSiteEnabled,
  siteDisabled,
  siteProfileFor,
  ZEOLITE_VERSION,
} from "../swstate";

/* The module holds one instance per worker evaluation; tests share it
   like the SW does. Toggles that must start from a known baseline are
   reset here; fingerprint state is set inside the tests that read it. */
beforeEach(() => {
  setHttpsUpgrade(false);
  setNavHandles(false);
  setRouteKey(null);
  setSiteEnabled("example.com", true);
});

describe("route-shape toggles (#53, #63, #55)", () => {
  it("https upgrade toggles and reports", () => {
    expect(isHttpsUpgrade()).toBe(false);
    setHttpsUpgrade(true);
    expect(isHttpsUpgrade()).toBe(true);
    setHttpsUpgrade(false);
    expect(isHttpsUpgrade()).toBe(false);
  });

  it("navHandles toggles and reports", () => {
    expect(navHandlesEnabled()).toBe(false);
    setNavHandles(true);
    expect(navHandlesEnabled()).toBe(true);
    setNavHandles(false);
    expect(navHandlesEnabled()).toBe(false);
  });

  it("the route key round-trips, including the null legacy default", () => {
    expect(getRouteKey()).toBeNull();
    setRouteKey("a-valid-key");
    expect(getRouteKey()).toBe("a-valid-key");
    setRouteKey(null);
    expect(getRouteKey()).toBeNull();
  });

  it("the degraded flag reports the last recorded reason", () => {
    setEngineDegraded("libcurl transport: init boom");
    expect(getEngineDegraded()).toBe("libcurl transport: init boom");
    setEngineDegraded("later failure");
    expect(getEngineDegraded()).toBe("later failure");
  });
});

describe("per-site route table", () => {
  it("matches the exact host and any parent domain suffix", () => {
    setSiteEnabled("example.com", false);
    expect(siteDisabled("https://example.com/")).toBe(true);
    expect(siteDisabled("https://sub.example.com/x")).toBe(true);
    expect(siteDisabled("https://deep.sub.example.com/y")).toBe(true);
  });

  it("does not match a lookalike or a subdomain-string host", () => {
    setSiteEnabled("example.com", false);
    expect(siteDisabled("https://notexample.com/")).toBe(false);
    expect(siteDisabled("https://example.com.evil.net/")).toBe(false);
    expect(siteDisabled("https://other.org/")).toBe(false);
  });

  it("re-enabling a site clears the block for all suffix matches", () => {
    setSiteEnabled("example.com", false);
    expect(siteDisabled("https://sub.example.com/")).toBe(true);
    setSiteEnabled("example.com", true);
    expect(siteDisabled("https://sub.example.com/")).toBe(false);
  });

  it("unparseable input is never disabled", () => {
    setSiteEnabled("example.com", false);
    expect(siteDisabled("not a url")).toBe(false);
  });
});

describe("fingerprint profile state (1.8 Telluride, #71, #80)", () => {
  it("accepts a valid profile and compiles the document + worker scripts", () => {
    const r = setFingerprint(DEFAULT_PROFILE);
    expect(r.ok).toBe(true);
    expect(getFpProfile()?.userAgent).toBe(DEFAULT_PROFILE.userAgent);
    expect(typeof getFpScript()).toBe("string");
    expect(getFpScript()!.length).toBeGreaterThan(0);
    expect(typeof getFpWorkerScript()).toBe("string");
    expect(getFpWorkerScript()!.length).toBeGreaterThan(0);
    setFingerprint(null);
  });

  it("null resets to fully native surfaces", () => {
    setFingerprint(DEFAULT_PROFILE);
    const r = setFingerprint(null);
    expect(r.ok).toBe(true);
    expect(getFpProfile()).toBeNull();
    expect(getFpScript()).toBeNull();
    expect(getFpWorkerScript()).toBeNull();
  });

  it("an invalid profile is refused and never changes active state", () => {
    setFingerprint(DEFAULT_PROFILE);
    const before = getFpProfile();
    const bad = setFingerprint({ userAgent: "curl/8.0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(typeof bad.error).toBe("string");
    expect(getFpProfile()).toBe(before);
    setFingerprint(null);
  });

  it("a profile bound away from the live engine is refused with a reason (#71)", () => {
    setFingerprint(DEFAULT_PROFILE);
    const bound = setFingerprint({ ...DEFAULT_PROFILE, engines: ["epoxy"] });
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.error).toContain("bound to");
    expect(getFpProfile()?.engines).toContain("libcurl");
    setFingerprint(null);
  });

  it("per-site profiles degrade to null, never throw (#80)", async () => {
    /* Unparseable target: null without touching the network. */
    expect(await siteProfileFor("::bad::")).toBeNull();
    /* A parseable target resolves through siteconfig data; the fetch
       fails in this environment, which means "no rules" = null, the
       same honest degrade a malformed siteconfig.json gets. */
    expect(await siteProfileFor("https://fresh.example/")).toBeNull();
  });
});

describe("docCookie port registry (#35)", () => {
  interface FakePort {
    port: MessagePort;
    messages: unknown[];
  }

  function fakePort(): FakePort {
    const messages: unknown[] = [];
    const port = {
      postMessage: (m: unknown) => messages.push(m),
      close: () => {},
    };
    return { port: port as unknown as MessagePort, messages };
  }

  it("pushes the fresh jar view to a registered client", () => {
    const f = fakePort();
    registerDocCookiePort("c1", f.port, "https://example.com/");
    pushDocCookieView("c1");
    expect(f.messages.length).toBe(1);
    const msg = f.messages[0] as { ok: boolean; cookie: string };
    expect(msg.ok).toBe(true);
    expect(typeof msg.cookie).toBe("string");
  });

  it("pushes nothing for an unregistered or empty client id", () => {
    const f = fakePort();
    pushDocCookieView("nope");
    pushDocCookieView("");
    expect(f.messages.length).toBe(0);
  });

  it("caps the registry: past the limit the oldest entry stops receiving", () => {
    const oldest = fakePort();
    registerDocCookiePort("oldest", oldest.port, "https://example.com/");
    /* Fill to the cap with distinct clients; the oldest is evicted. */
    for (let i = 0; i < 128; i++) {
      registerDocCookiePort("filler" + i, fakePort().port, "https://example.com/");
    }
    pushDocCookieView("oldest");
    expect(oldest.messages.length).toBe(0);
    /* The newest registrant still receives pushes. */
    const newest = fakePort();
    registerDocCookiePort("newest", newest.port, "https://example.com/");
    pushDocCookieView("newest");
    expect(newest.messages.length).toBe(1);
  });
});

describe("shared instances", () => {
  it("exports the single DownloadTracker the engine feeds", () => {
    expect(DL).toBeInstanceOf(DownloadTracker);
  });

  it("exports the per-client virtual context map", () => {
    expect(VCTX).toBeInstanceOf(Map);
  });

  it("exports the runtime version banner", () => {
    expect(typeof ZEOLITE_VERSION).toBe("string");
    expect(ZEOLITE_VERSION.length).toBeGreaterThan(0);
  });
});
