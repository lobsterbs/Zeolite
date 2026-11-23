/* 2026-11-23 (epoxy identity lane): the TLS hello follows the armed
   wire-default UA. epoxyIdentityForUa maps chromium-family UAs to the
   fork's brave profile, Firefox UAs to the firefox profile, and
   everything else (including the empty un-armed default) to the native
   stock-rustls hello. */
import { describe, expect, it } from "vitest";
import { epoxyIdentityForUa, epoxyIdentityVoiceOf } from "../libcurl-transport-vendored";

const X11_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const CROS_CHROME_158 =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const LYNX = "Lynx/2.8.9rel.1 libwww-FM/2.14 SSL-MM/1.4.1";

describe("epoxyIdentityForUa (UA-synced TLS hello)", () => {
  it("maps chromium-family UAs to the brave hello (1)", () => {
    for (const ua of [X11_CHROME, MAC_CHROME, EDGE, CROS_CHROME_158]) {
      expect(epoxyIdentityForUa(ua)).toBe(1);
    }
    expect(epoxyIdentityForUa("Mozilla/5.0 (X11; Linux x86_64) Chromium/158.0.0.0")).toBe(1);
  });

  it("maps firefox UAs to the firefox hello (2)", () => {
    expect(epoxyIdentityForUa(FIREFOX)).toBe(2);
  });

  it("maps other, malformed, and empty UAs to the native hello (0)", () => {
    for (const ua of [SAFARI, LYNX, "not a ua", ""]) {
      expect(epoxyIdentityForUa(ua)).toBe(0);
    }
  });

  it("does not fire on substrings that lack the version slash", () => {
    /* "Firefox" inside a token like a product name must not shape the
       hello; the real family strings carry Firefox/<version>. */
    expect(epoxyIdentityForUa("Mozilla/5.0 (compatible; FirefoxBot/0.1)")).toBe(0);
    expect(epoxyIdentityForUa("Mozilla/5.0 (compatible; Chromebot)")).toBe(0);
  });
});

describe("epoxyIdentityVoiceOf (explicit TLS voice pin)", () => {
  it("maps the settings voices to the wire identities", () => {
    expect(epoxyIdentityVoiceOf("chromium")).toBe(1);
    expect(epoxyIdentityVoiceOf("firefox")).toBe(2);
    expect(epoxyIdentityVoiceOf("native")).toBe(0);
  });

  it("maps absent, junk, and wrong types to null (UA-synced)", () => {
    for (const v of [undefined, null, "ua", "chrome", "Firefox", 1, "", {}]) {
      expect(epoxyIdentityVoiceOf(v)).toBeNull();
    }
  });
});
