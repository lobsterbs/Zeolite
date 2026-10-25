import { describe, expect, it } from "vitest";
import { clientHintsForUa, formatUaBrands } from "../useragent";
import { applyChUa } from "../origin";
import { DEFAULT_PROFILE, fingerprintScript, resolveProfile, workerFingerprintScript } from "../fingerprint";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.12 Safari/537.36";
const NATIVE = "Mozilla/5.0 (X11; CrOS x86_64 16123.0.0) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";
const entropy = ["fullVersionList", "uaFullVersion", "platformVersion", "architecture", "bitness", "model", "wow64"];
function realm(worker: boolean, matchUserAgent = true, ua = UA) {
  class Navigator {
    get userAgent() { return NATIVE; } get appVersion() { return "native version"; }
    get platform() { return "Linux x86_64"; } get language() { return "nb-NO"; }
    get languages() { return ["nb-NO"]; } get userAgentData() { return nativeData; }
  }
  const nativeData = { brands: [{ brand: "Physical Chrome", version: "154" }], mobile: false, platform: "Chrome OS",
    toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
    async getHighEntropyValues(_hints?: unknown) { return { physical: true }; } };
  const global = { navigator: new Navigator() };
  const p = resolveProfile({ userAgent: ua, matchUserAgent, canvasSeed: "unit" });
  new Function("Navigator", "globalThis", worker ? workerFingerprintScript(p) : fingerprintScript(p))(Navigator, global);
  return { nav: global.navigator, nativeData };
}
describe("shared UA identity (#429/#437)", () => {
  it("keeps window, worker and low/high entropy wire identity in agreement", async () => {
    for (const worker of [false, true]) {
      const { nav, nativeData } = realm(worker);
      expect(nav.userAgent).toBe(UA); expect(nav.platform).toBe("Win32"); expect(nav.userAgentData).toBe(nativeData);
      const data: any = await nav.userAgentData.getHighEntropyValues(entropy);
      const wire = new Headers({ "sec-ch-ua-full-version-list": "physical", "sec-ch-ua-full-version": "physical",
        "sec-ch-ua-platform-version": "physical", "sec-ch-ua-arch": "physical", "sec-ch-ua-bitness": "physical",
        "sec-ch-ua-model": "physical", "sec-ch-ua-wow64": "?0" });
      applyChUa(wire, UA);
      expect(wire.get("sec-ch-ua")).toBe(formatUaBrands(data.brands));
      expect(wire.get("sec-ch-ua-full-version-list")).toBe(formatUaBrands(data.fullVersionList));
      expect(wire.get("sec-ch-ua-full-version")).toBe(JSON.stringify(data.uaFullVersion));
      expect(wire.get("sec-ch-ua-platform")).toBe(JSON.stringify(data.platform));
      expect(wire.get("sec-ch-ua-mobile")).toBe(data.mobile ? "?1" : "?0");
      expect(wire.get("sec-ch-ua-arch")).toBe(JSON.stringify(data.architecture));
      expect(wire.get("sec-ch-ua-bitness")).toBe(JSON.stringify(data.bitness));
      for (const k of ["platformVersion", "model", "wow64"]) expect(data).not.toHaveProperty(k);
      for (const k of ["platform-version", "model", "wow64"]) expect(wire.has("sec-ch-ua-" + k)).toBe(false);
      expect(data.uaFullVersion).toBe(clientHintsForUa(UA)!.uaFullVersion);
      expect(nav.userAgentData.toJSON().platform).toBe("Windows");
      const brands = nav.userAgentData.brands; brands[0].brand = "changed";
      expect(nav.userAgentData.brands[0].brand).not.toBe("changed");
    }
  });
  it("preserves native high entropy when no identity is changed", () => {
    const h = new Headers({ "sec-ch-ua-platform-version": "native", "sec-ch-ua-model": "native" });
    applyChUa(h, NATIVE, true); expect(h.get("sec-ch-ua-model")).toBe("native"); expect(h.get("sec-ch-ua-platform-version")).toBe("native");
  });
  it("does not send unrequested high entropy", () => {
    const h = new Headers(); applyChUa(h, UA);
    for (const k of ["full-version", "full-version-list", "arch"]) expect(h.has("sec-ch-ua-" + k)).toBe(false);
  });
  it("keeps all native UA surfaces when matching is disabled", async () => {
    for (const worker of [false, true]) {
      const { nav } = realm(worker, false);
      expect(nav.userAgent).toBe(NATIVE); expect(nav.appVersion).toBe("native version"); expect(nav.platform).toBe("Linux x86_64");
      expect(nav.userAgentData.platform).toBe("Chrome OS"); expect(await nav.userAgentData.getHighEntropyValues()).toEqual({ physical: true });
      expect(nav.language).toBe("en-US");
    }
  });
  it("does not expose Chromium data for a non-Chromium UA", () => {
    const ff = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0";
    expect(clientHintsForUa(ff)).toBeNull(); const h = new Headers({ "sec-ch-ua": "physical", "sec-ch-ua-model": "physical" });
    applyChUa(h, ff); expect([...h.keys()]).toEqual([]);
    expect(realm(false, true, ff).nav.userAgentData).toBeUndefined(); expect(realm(true, true, ff).nav.userAgentData).toBeUndefined();
  });
  it("does not invent full versions/CPUs from absent markers", () => {
    const ua = "Mozilla/5.0 (Linux; Android 13) Chrome/149 Mobile"; const data = clientHintsForUa(ua)!;
    for (const k of ["uaFullVersion", "fullVersionList", "architecture", "bitness"]) expect(data).not.toHaveProperty(k);
    const h = new Headers({ "sec-ch-ua-full-version": "physical", "sec-ch-ua-arch": "physical" }); applyChUa(h, ua);
    expect(h.has("sec-ch-ua-full-version")).toBe(false); expect(h.has("sec-ch-ua-arch")).toBe(false);
  });
  it("does not mistake Win64 for an x86 CPU on ARM", () => {
    expect(clientHintsForUa(UA.replace("Win64; x64", "Win64; arm64"))?.architecture).toBe("arm");
    expect(clientHintsForUa(UA.replace("Win64; x64", "Win64"))).not.toHaveProperty("architecture");
  });
  it("does not invent userAgentData where the browser has no such API", () => {
    for (const userAgent of [UA, "Mozilla/5.0 (Windows NT 10.0; rv:149.0) Gecko/20100101 Firefox/149.0"]) {
      class Navigator {} const global = { navigator: new Navigator() };
      new Function("Navigator", "globalThis", fingerprintScript(resolveProfile({ userAgent })))(Navigator, global);
      expect("userAgentData" in global.navigator).toBe(false);
    }
  });
  it("defaults and validates the host option", () => {
    expect(resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent }).matchUserAgent).toBe(true);
    expect(resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, matchUserAgent: false }).matchUserAgent).toBe(false);
    expect(() => resolveProfile({ userAgent: DEFAULT_PROFILE.userAgent, matchUserAgent: "false" })).toThrow("matchUserAgent");
  });
});
