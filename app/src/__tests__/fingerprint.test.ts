import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  canvasSeedHash,
  fingerprintScript,
  resolveProfile,
  workerFingerprintScript,
} from "../fingerprint";

describe("resolveProfile", () => {
  it("derives the platform from the user agent", () => {
    const p = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent });
    expect(p.platform).toBe("Win32");
    const mac = resolveProfile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
    expect(mac.platform).toBe("MacIntel");
  });

  it("refuses contradictory platform/userAgent pairs", () => {
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, platform: "MacIntel" })).toThrow("contradictory");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, platform: "TotallyBogus" })).toThrow("platform");
  });

  it("refuses non-UA strings", () => {
    expect(() => resolveProfile({})).toThrow("userAgent");
    expect(() => resolveProfile(null)).toThrow("object");
    expect(() => resolveProfile({ userAgent: "curl/8.0" })).toThrow("userAgent");
  });

  it("fills language, timezone, hardware and memory defaults honestly", () => {
    const p = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent });
    expect(p.languages).toEqual(["en-US", "en"]);
    expect(p.utcOffsetMin).toBeNull();
    expect(p.timezoneName).toBeNull();
    expect(p.hardwareConcurrency).toBeNull();
    expect(p.deviceMemoryGB).toBeNull();
    expect(p.screen).toBeNull();
    expect(p.webglVendor).toBeNull();
    expect(p.webglRenderer).toBeNull();
    expect(p.canvasSeed).toBe(DEFAULT_PROFILE.canvasSeed);
  });

  it("validates numeric surfaces", () => {
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, hardwareConcurrency: 0 })).toThrow("hardwareConcurrency");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, hardwareConcurrency: 999 })).toThrow("hardwareConcurrency");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, deviceMemoryGB: 0 })).toThrow("deviceMemoryGB");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, deviceMemoryGB: 4096 })).toThrow("deviceMemoryGB");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, utcOffsetMin: 15.5 })).toThrow("utcOffsetMin");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, utcOffsetMin: 9999 })).toThrow("utcOffsetMin");
  });

  it("validates screen shape and webgl pairs", () => {
    const ok = resolveProfile({
      userAgent: DEFAULT_PROFILE.userAgent,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    });
    expect(ok.screen?.availHeight).toBe(1040);
    expect(() =>
      resolveProfile({
        userAgent: DEFAULT_PROFILE.userAgent,
        screen: { width: 800, height: 600, availWidth: 801, availHeight: 600, colorDepth: 24, pixelDepth: 24 },
      }),
    ).toThrow("avail");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, webglVendor: "x" })).toThrow("pair");
    expect(() =>
      resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, webglVendor: "x", webglRenderer: "" }),
    ).toThrow("webgl");
  });

  it("validates language list and zone name", () => {
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, languages: [] })).toThrow("languages");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, languages: ["not a lang"] })).toThrow("languages");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, timezoneName: "not a zone!!" })).toThrow("timezoneName");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, canvasSeed: "" })).toThrow("canvasSeed");
  });

  it("keeps the default profile internally consistent", () => {
    const p = resolveProfile(DEFAULT_PROFILE);
    expect(p.platform).toBe(DEFAULT_PROFILE.platform);
    expect(p.languages[0]).toBe("en-US");
    expect(p.timezoneName).toBe("UTC");
    expect(p.utcOffsetMin).toBe(0);
  });
});

describe("canvas seed", () => {
  it("is a stable function of the profile string", () => {
    expect(canvasSeedHash("zeolite-telluride")).toBe(canvasSeedHash("zeolite-telluride"));
    expect(canvasSeedHash("a")).not.toBe(canvasSeedHash("b"));
  });
});

describe("fingerprintScript", () => {
  it("is deterministic and side-effect free", () => {
    const a = fingerprintScript(DEFAULT_PROFILE);
    const b = fingerprintScript(DEFAULT_PROFILE);
    expect(a).toBe(b);
    expect(a).not.toContain("Math.random");
    expect(a).not.toContain("Date.now");
    expect(a).not.toContain("</script");
  });

  it("embeds the profile values it spoofs", () => {
    const s = fingerprintScript(DEFAULT_PROFILE);
    expect(s).toContain(DEFAULT_PROFILE.userAgent);
    expect(s).toContain('"Win32"');
    expect(s).toContain("hardwareConcurrency");
    expect(s).toContain("deviceMemory");
    expect(s).toContain("37445");
    expect(s).toContain("37446");
    expect(s).toContain("getTimezoneOffset");
    expect(s).toContain("Intl.DateTimeFormat");
    expect(s).toContain("toDataURL");
    expect(s).toContain("getImageData");
    expect(s).toContain(String(canvasSeedHash(DEFAULT_PROFILE.canvasSeed)));
  });

  it("omits patches the profile leaves native", () => {
    const bare = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, canvasSeed: "x" });
    const s = fingerprintScript(bare);
    expect(s).not.toContain("hardwareConcurrency");
    expect(s).not.toContain("deviceMemory");
    expect(s).not.toContain("Screen.prototype");
    expect(s).not.toContain("getTimezoneOffset");
    expect(s).not.toContain("37445");
  });
});

describe("workerFingerprintScript (2.3 Selenide)", () => {
  it("is deterministic and side-effect free", () => {
    const a = workerFingerprintScript(DEFAULT_PROFILE);
    const b = workerFingerprintScript(DEFAULT_PROFILE);
    expect(a).toBe(b);
    expect(a).not.toContain("Math.random");
    expect(a).not.toContain("Date.now");
  });

  it("patches WorkerNavigator surfaces, not document ones", () => {
    const s = workerFingerprintScript(DEFAULT_PROFILE);
    expect(s).toContain(DEFAULT_PROFILE.userAgent);
    expect(s).toContain('"Win32"');
    expect(s).toContain("hardwareConcurrency");
    expect(s).toContain("deviceMemory");
    expect(s).toContain("globalThis.navigator");
    expect(s).not.toContain("Navigator.prototype");
    expect(s).not.toContain("Screen.prototype");
    expect(s).not.toContain("HTMLCanvasElement");
  });

  it("perturbs OffscreenCanvas with the same seed as documents", () => {
    const s = workerFingerprintScript(DEFAULT_PROFILE);
    expect(s).toContain("OffscreenCanvas");
    expect(s).toContain("convertToBlob");
    expect(s).toContain("transferToImageBitmap");
    expect(s).toContain("getImageData");
    expect(s).toContain(String(canvasSeedHash(DEFAULT_PROFILE.canvasSeed)));
    const doc = fingerprintScript(DEFAULT_PROFILE);
    const seed = String(canvasSeedHash(DEFAULT_PROFILE.canvasSeed));
    expect(s).toContain(seed);
    expect(doc).toContain(seed);
  });

  it("carries timezone and webgl patches when the profile sets them", () => {
    const s = workerFingerprintScript(DEFAULT_PROFILE);
    expect(s).toContain("getTimezoneOffset");
    expect(s).toContain("Intl.DateTimeFormat");
    expect(s).toContain("37445");
    expect(s).toContain("37446");
  });

  it("omits patches the profile leaves native", () => {
    const bare = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, canvasSeed: "x" });
    const s = workerFingerprintScript(bare);
    expect(s).not.toContain("hardwareConcurrency");
    expect(s).not.toContain("deviceMemory");
    expect(s).not.toContain("getTimezoneOffset");
    expect(s).not.toContain("37445");
  });
});
