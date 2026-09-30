import { describe, expect, it } from "vitest";
import { wsIdentityHeaders, wsTargetForLookups, type WsIdentityProfile } from "../wsidentity";

/* Per-origin virtual WS identities (deep-integration item 4): the
   bridged ws handshake must carry the initiator's origin, the jar's
   cookies for the target and the per-site UA - not the single bridge
   identity every site used to share. All lookups are injected, so no
   jar/rules state is needed here. */

const uaFor = (url: string) => (url.includes("auth.example") ? "SiteUA/1.0" : null);
const cookieFor = (url: string) => (url.includes("auth.example") ? "sid=1; theme=dark" : null);
const opts = { uaFor, cookieFor };

const profile: WsIdentityProfile = { userAgent: "ProfileUA/2.0", languages: ["en-US", "en"] };

describe("wsIdentityHeaders", () => {
  it("carries the initiator origin, site UA and jar cookie", () => {
    const h = wsIdentityHeaders("https://page.example/", "wss://auth.example/ws", opts);
    expect(h).toEqual([
      ["origin", "https://page.example"],
      ["user-agent", "SiteUA/1.0"],
      ["cookie", "sid=1; theme=dark"],
    ]);
  });

  it("omits absent pieces honestly (no origin, no UA, no cookie)", () => {
    expect(wsIdentityHeaders(undefined, "wss://plain.example/ws", opts)).toEqual([]);
    expect(wsIdentityHeaders(null, "wss://plain.example/ws", opts)).toEqual([]);
  });

  it("drops a malformed initiator origin instead of forwarding it", () => {
    expect(wsIdentityHeaders("not a url", "wss://plain.example/ws", opts)).toEqual([]);
    expect(wsIdentityHeaders("ftp://x/", "wss://plain.example/ws", opts)).toEqual([]);
  });

  it("maps ws:/wss: targets to http:/https: for lookups", () => {
    const seen: string[] = [];
    const h = wsIdentityHeaders("https://page.example/", "wss://auth.example/ws", {
      uaFor: (u) => (seen.push(u), null),
      cookieFor: (u) => (seen.push(u), null),
    });
    expect(h).toEqual([["origin", "https://page.example"]]);
    expect(seen).toEqual([
      "https://auth.example/ws",
      "https://auth.example/ws",
    ]);
  });

  it("wsTargetForLookups passes non-ws schemes through untouched", () => {
    expect(wsTargetForLookups("ws://a.example/x")).toBe("http://a.example/x");
    expect(wsTargetForLookups("wss://a.example/x")).toBe("https://a.example/x");
    expect(wsTargetForLookups("https://a.example/x")).toBe("https://a.example/x");
    expect(wsTargetForLookups("garbage")).toBe("garbage");
  });

  it("a fingerprint profile wins over the site UA and pins accept-language", () => {
    const h = wsIdentityHeaders("https://page.example/", "wss://spoof.example/ws", { ...opts, profile });
    expect(h).toEqual([
      ["origin", "https://page.example"],
      ["user-agent", "ProfileUA/2.0"],
      ["accept-language", "en-US,en"],
    ]);
  });

  it("an http initiator origin is kept (native pages may be plain http)", () => {
    const h = wsIdentityHeaders("http://page.example/", "wss://plain.example/ws", opts);
    expect(h).toEqual([["origin", "http://page.example"]]);
  });
});
