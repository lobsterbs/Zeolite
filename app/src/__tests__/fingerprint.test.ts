import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  canvasSeedHash,
  canonicalZoneForOffset,
  engineBindingError,
  etcNameOffsetMin,
  fingerprintScript,
  offsetZoneString,
  resolveProfile,
  timezoneIdentityFor,
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

  it("audioNoise defaults off, accepts booleans, refuses others (#141)", () => {
    const off = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent });
    expect(off.audioNoise).toBe(false);
    const on = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, audioNoise: true });
    expect(on.audioNoise).toBe(true);
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, audioNoise: "yes" })).toThrow("audioNoise");
  });

  it("defaults the engine binding to both engines and validates it (#71)", () => {
    const p = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent });
    expect(p.engines).toEqual(["libcurl", "epoxy"]);
    const bound = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, engines: ["epoxy"] });
    expect(bound.engines).toEqual(["epoxy"]);
    const dedup = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, engines: ["epoxy", "epoxy"] });
    expect(dedup.engines).toEqual(["epoxy"]);
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, engines: [] })).toThrow("engines");
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, engines: ["scramjet"] })).toThrow("engines");
  });
});

describe("engine binding (#71)", () => {
  it("refuses profiles bound away from the live engine, applies bound ones", () => {
    const epoxyOnly = resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, engines: ["epoxy"] });
    expect(engineBindingError(epoxyOnly, "epoxy")).toBeNull();
    const err = engineBindingError(epoxyOnly, "libcurl");
    expect(err).toContain("epoxy");
    expect(err).toContain("libcurl");
    expect(engineBindingError(DEFAULT_PROFILE, "libcurl")).toBeNull();
    expect(engineBindingError(DEFAULT_PROFILE, "epoxy")).toBeNull();
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

describe("bug-scout 2026-10-16 (#223, #224, #225)", () => {
  const UA = DEFAULT_PROFILE.userAgent;

  it("timezoneName without utcOffsetMin patches Intl only, never forces a UTC Date surface (#223)", () => {
    const p = resolveProfile({ userAgent: UA, timezoneName: "America/New_York" });
    const doc = fingerprintScript(p);
    expect(doc).toContain("America/New_York");
    expect(doc).not.toContain("getTimezoneOffset");
    const w = workerFingerprintScript(p);
    expect(w).toContain("America/New_York");
    expect(w).not.toContain("getTimezoneOffset");
  });

  it("utcOffsetMin without timezoneName derives the canonical Etc zone for Intl (#540, was Date-only under #223)", () => {
    const p = resolveProfile({ userAgent: UA, utcOffsetMin: 120 });
    const doc = fingerprintScript(p);
    expect(doc).toContain("getTimezoneOffset");
    expect(doc).toContain("Etc/GMT-2");
    expect(doc).toContain("Intl.DateTimeFormat");
    const w = workerFingerprintScript(p);
    expect(w).toContain("getTimezoneOffset");
    expect(w).toContain("Etc/GMT-2");
    expect(w).toContain("Intl.DateTimeFormat");
  });

  it("the toDataURL/toBlob copy path reads pristine pixels through a captured getImageData (#224)", () => {
    const doc = fingerprintScript(DEFAULT_PROFILE);
    expect(doc).toMatch(/zlOrigGID\.call\(ctx/);
    const w = workerFingerprintScript(DEFAULT_PROFILE);
    expect(w).toMatch(/zlOrigWGID \? zlOrigWGID\.call\(ctx/);
  });

  it("worker transferToImageBitmap clears the source canvas like the native method (#225)", () => {
    const w = workerFingerprintScript(DEFAULT_PROFILE);
    expect(w).toMatch(/transferToImageBitmap = function \(\) \{[\s\S]{0,220}this\.width = this\.width/);
  });
});

/* #540: the profile contract is NARROWED to a self-consistent fixed
   offset, expressed through real IANA fixed-offset zones so Date and
   Intl agree everywhere. No timezone database: Etc/GMT sign mapping +
   offset strings for the gaps, zone text formatted from the offset. */
describe("fixed-offset timezone identity (#540)", () => {
  const UA = DEFAULT_PROFILE.userAgent;

  it("maps whole-hour offsets onto real IANA Etc/GMT zones with the inverted sign", () => {
    expect(canonicalZoneForOffset(300)).toEqual({ zone: "Etc/GMT-5", kind: "iana" });
    expect(canonicalZoneForOffset(-300)).toEqual({ zone: "Etc/GMT+5", kind: "iana" });
    expect(canonicalZoneForOffset(0)).toEqual({ zone: "Etc/GMT", kind: "iana" });
    expect(canonicalZoneForOffset(120)).toEqual({ zone: "Etc/GMT-2", kind: "iana" });
    expect(canonicalZoneForOffset(840)).toEqual({ zone: "Etc/GMT-14", kind: "iana" });
  });

  it("falls back to Intl offset strings where IANA defines no Etc zone", () => {
    expect(canonicalZoneForOffset(330)).toEqual({ zone: "+05:30", kind: "offset" });
    expect(canonicalZoneForOffset(-330)).toEqual({ zone: "-05:30", kind: "offset" });
    /* Etc/GMT only reaches +12 west: UTC-13/-14 have no real zone */
    expect(canonicalZoneForOffset(-780)).toEqual({ zone: "-13:00", kind: "offset" });
    expect(canonicalZoneForOffset(-840)).toEqual({ zone: "-14:00", kind: "offset" });
    expect(offsetZoneString(45)).toBe("+00:45");
  });

  it("sign-maps Etc/GMT zone names for verification (IANA Etc/GMT-N is UTC+N)", () => {
    expect(etcNameOffsetMin("Etc/GMT-5")).toBe(300);
    expect(etcNameOffsetMin("Etc/GMT+5")).toBe(-300);
    expect(etcNameOffsetMin("Etc/GMT")).toBe(0);
    expect(etcNameOffsetMin("Etc/GMT-14")).toBe(840);
    expect(etcNameOffsetMin("America/New_York")).toBeNull();
    expect(etcNameOffsetMin("UTC")).toBeNull();
    expect(etcNameOffsetMin("not a zone")).toBeNull();
  });

  it("the explicit timezoneName wins for Intl; the offset still owns Date", () => {
    expect(timezoneIdentityFor({ utcOffsetMin: 300, timezoneName: "America/New_York" })).toEqual({ zone: "America/New_York", derived: false });
    expect(timezoneIdentityFor({ utcOffsetMin: 300, timezoneName: null })).toEqual({ zone: "Etc/GMT-5", derived: true });
    expect(timezoneIdentityFor({ utcOffsetMin: 330, timezoneName: null })).toEqual({ zone: "+05:30", derived: true });
    expect(timezoneIdentityFor({ utcOffsetMin: null, timezoneName: null })).toBeNull();
  });

  it("an Etc/GMT name that contradicts utcOffsetMin is recorded, never rewritten", () => {
    const bad = resolveProfile({ userAgent: UA, timezoneName: "Etc/GMT+5", utcOffsetMin: 300 });
    expect(bad.timezoneName).toBe("Etc/GMT+5");
    expect(bad.timezoneInconsistent).toBe(true);
    const agree = resolveProfile({ userAgent: UA, timezoneName: "Etc/GMT-5", utcOffsetMin: 300 });
    expect(agree.timezoneInconsistent).toBeUndefined();
    const zero = resolveProfile({ userAgent: UA, timezoneName: "Etc/GMT", utcOffsetMin: 0 });
    expect(zero.timezoneInconsistent).toBeUndefined();
    /* non-Etc names cannot be verified without a tz database: not checked */
    const ny = resolveProfile({ userAgent: UA, timezoneName: "America/New_York", utcOffsetMin: 300 });
    expect(ny.timezoneInconsistent).toBeUndefined();
    /* an offset alone never carries the flag */
    const off = resolveProfile({ userAgent: UA, utcOffsetMin: 300 });
    expect(off.timezoneInconsistent).toBeUndefined();
  });

  /* Executes the compiled script against isolated Date/Intl objects so
     the patch lands on stand-ins, not the test runner's globals. */
  function tzRealm(worker: boolean, fields: Record<string, unknown>) {
    class Navigator {}
    const global = { navigator: new Navigator() };
    const p = resolveProfile({ userAgent: UA, ...fields });
    const code = worker ? workerFingerprintScript(p) : fingerprintScript(p);
    const FakeDate = class extends Date {};
    const intlBox: { DateTimeFormat: typeof Intl.DateTimeFormat } = { DateTimeFormat: Intl.DateTimeFormat };
    new Function("Navigator", "globalThis", "Date", "Intl", code)(Navigator, global, FakeDate, intlBox);
    return { FakeDate, FakeIntl: intlBox, profile: p };
  }
  const TS = Date.UTC(2027, 10, 1, 10, 0, 0); /* 2027-11-01T10:00Z, a Monday */

  it("Date.toString/toTimeString zone text is the Chromium Etc shape, stable across reads", () => {
    for (const worker of [false, true]) {
      const { FakeDate } = tzRealm(worker, { utcOffsetMin: 120 });
      const d = new FakeDate(TS);
      expect(d.getTimezoneOffset()).toBe(-120);
      expect(d.getHours()).toBe(12);
      expect(d.getMinutes()).toBe(0);
      expect(d.toString()).toBe("Mon Nov 01 2027 12:00:00 GMT+0200 (GMT+02:00)");
      /* determinism: repeated reads are byte-identical */
      expect(d.toString()).toBe(d.toString());
      expect(d.toTimeString()).toBe("12:00:00 GMT+0200 (GMT+02:00)");
      /* negative offsets keep the shape with the sign moved in */
      const neg = new (tzRealm(worker, { utcOffsetMin: -300 }).FakeDate)(TS);
      expect(neg.toString()).toBe("Mon Nov 01 2027 05:00:00 GMT-0500 (GMT-05:00)");
      expect(neg.toTimeString()).toBe("05:00:00 GMT-0500 (GMT-05:00)");
    }
  });

  it("Intl with no explicit timeZone resolves to the canonical zone and agrees with the Date getters", () => {
    for (const worker of [false, true]) {
      const { FakeDate, FakeIntl } = tzRealm(worker, { utcOffsetMin: 300 });
      const fmt = new FakeIntl.DateTimeFormat("en-US", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
      expect(fmt.resolvedOptions().timeZone).toBe("Etc/GMT-5");
      const parts = new Map(fmt.formatToParts(new FakeDate(TS)).map((x) => [x.type, x.value]));
      const d = new FakeDate(TS);
      expect(parts.get("year")).toBe(String(d.getFullYear()));
      expect(parts.get("month")).toBe(String(d.getMonth() + 1).padStart(2, "0"));
      expect(parts.get("day")).toBe(String(d.getDate()).padStart(2, "0"));
      expect(parts.get("hour")).toBe(String(d.getHours()).padStart(2, "0"));
      expect(parts.get("minute")).toBe(String(d.getMinutes()).padStart(2, "0"));
      expect(parts.get("second")).toBe(String(d.getSeconds()).padStart(2, "0"));
    }
  });

  it("the Etc path does NOT shift across a real America/New_York DST boundary (the narrowed contract)", () => {
    for (const worker of [false, true]) {
      const { FakeDate, FakeIntl } = tzRealm(worker, { utcOffsetMin: 0 });
      /* America/New_York spring-forward: 2027-03-14 07:00Z (2:00 EST -> 3:00 EDT) */
      const before = Date.UTC(2027, 2, 14, 6, 0, 0);
      const after = Date.UTC(2027, 2, 14, 8, 0, 0);
      const nyHour = (t: number) =>
        Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
      /* the boundary is real: the named zone shifts 1:00 -> 4:00 */
      expect(nyHour(before)).toBe(1);
      expect(nyHour(after)).toBe(4);
      /* the fixed-offset identity deliberately does not follow it */
      expect(new FakeDate(before).getHours()).toBe(6);
      expect(new FakeDate(after).getHours()).toBe(8);
      const fmt = new FakeIntl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23" });
      expect(["Etc/GMT", "UTC"]).toContain(fmt.resolvedOptions().timeZone);
      expect(Number(fmt.format(before))).toBe(6);
      expect(Number(fmt.format(after))).toBe(8);
    }
  });

  it("half-hour offsets keep the fixed Date behavior and give Intl an offset string", () => {
    for (const worker of [false, true]) {
      const { FakeDate, FakeIntl } = tzRealm(worker, { utcOffsetMin: 330 });
      const d = new FakeDate(TS);
      expect(d.getTimezoneOffset()).toBe(-330);
      expect(d.toString()).toBe("Mon Nov 01 2027 15:30:00 GMT+0530 (GMT+05:30)");
      expect(new FakeIntl.DateTimeFormat("en-US").resolvedOptions().timeZone).toBe("+05:30");
    }
  });

  it("an explicit timezoneName still wins where supplied (#540)", () => {
    for (const worker of [false, true]) {
      const { FakeDate, FakeIntl, profile } = tzRealm(worker, { utcOffsetMin: 300, timezoneName: "America/New_York" });
      expect(new FakeIntl.DateTimeFormat("en-US").resolvedOptions().timeZone).toBe("America/New_York");
      /* the Date surface stays on the offset; the contradiction (if any)
         was already resolved at resolveProfile time */
      expect(new FakeDate(TS).getTimezoneOffset()).toBe(-300);
      expect(profile.timezoneName).toBe("America/New_York");
    }
  });

  it("toJSON stays the UTC ISO form, exactly like real Chromium in every zone", () => {
    for (const worker of [false, true]) {
      const { FakeDate } = tzRealm(worker, { utcOffsetMin: 330 });
      expect(new FakeDate(TS).toJSON()).toBe(new Date(TS).toISOString());
      expect(new FakeDate(TS).toISOString()).toBe("2027-11-01T10:00:00.000Z");
    }
  });

  it("invalid dates still render Invalid Date", () => {
    const { FakeDate } = tzRealm(false, { utcOffsetMin: 120 });
    expect(new FakeDate(NaN).toString()).toBe("Invalid Date");
    expect(new FakeDate(NaN).toTimeString()).toBe("Invalid Date");
  });
});
