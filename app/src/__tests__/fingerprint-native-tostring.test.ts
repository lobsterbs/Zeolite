import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { DEFAULT_PROFILE, fingerprintScript, workerFingerprintScript } from "../fingerprint";

/* #716: every function the fingerprint scripts patch on a prototype
   must stringify as native code, and unpatched functions must keep
   their real source. The scripts run inside a vm page stub. */

function pageCtx() {
  return vm.createContext({
    Navigator: { prototype: {} },
    Screen: { prototype: {} },
    navigator: {
      userAgent: DEFAULT_PROFILE.userAgent,
      userAgentData: { brands: [], mobile: false, platform: "Windows" },
    },
    HTMLCanvasElement: { prototype: { toDataURL() { return ""; }, toBlob() {} } },
    CanvasRenderingContext2D: { prototype: { getImageData() { return { data: [] }; } } },
    WebGLRenderingContext: { prototype: { getParameter() { return ""; } } },
    AnalyserNode: { prototype: { getFloatFrequencyData() {}, getByteFrequencyData() {} } },
  });
}

function evalScript(src: string) {
  const ctx = pageCtx();
  vm.runInContext(src, ctx);
  return ctx;
}

function str(ctx: vm.Context, code: string): string {
  return vm.runInContext(code, ctx) as string;
}

describe("fingerprint native-code shield (#716)", () => {
  it("patched getters report [native code] through every toString path", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get)"))
      .toBe("function get userAgent() { [native code] }");
    expect(str(ctx, "Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get)"))
      .toBe("function get userAgent() { [native code] }");
    expect(str(ctx, "Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.toString()"))
      .toBe("function get userAgent() { [native code] }");
  });

  it("unpatched functions keep their real source", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "(function zlReal() { return 1; }).toString()")).toContain("return 1");
  });

  it("Function.prototype.toString itself reports native code", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(Function.prototype.toString)")).toBe("function toString() { [native code] }");
  });

  it("patched Date and Intl surfaces report [native code]", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(Date.prototype.getTimezoneOffset)")).toBe("function getTimezoneOffset() { [native code] }");
    expect(str(ctx, "String(Date.prototype.toString)")).toBe("function toString() { [native code] }");
    expect(str(ctx, "String(Date.prototype.toTimeString)")).toBe("function toTimeString() { [native code] }");
    expect(str(ctx, "String(Date.prototype.getFullYear)")).toBe("function getFullYear() { [native code] }");
    expect(str(ctx, "String(Intl.DateTimeFormat)")).toBe("function DateTimeFormat() { [native code] }");
  });

  it("patched prototype methods report [native code]", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(HTMLCanvasElement.prototype.toDataURL)")).toBe("function toDataURL() { [native code] }");
    expect(str(ctx, "String(HTMLCanvasElement.prototype.toBlob)")).toBe("function toBlob() { [native code] }");
    expect(str(ctx, "String(CanvasRenderingContext2D.prototype.getImageData)")).toBe("function getImageData() { [native code] }");
    expect(str(ctx, "String(WebGLRenderingContext.prototype.getParameter)")).toBe("function getParameter() { [native code] }");
  });

  it("analyser patches report [native code] when the profile arm is on", () => {
    const ctx = evalScript(fingerprintScript({ ...DEFAULT_PROFILE, audioNoise: true }));
    expect(str(ctx, "String(AnalyserNode.prototype.getFloatFrequencyData)")).toBe("function getFloatFrequencyData() { [native code] }");
    expect(str(ctx, "String(AnalyserNode.prototype.getByteFrequencyData)")).toBe("function getByteFrequencyData() { [native code] }");
  });

  it("userAgentData toJSON and getHighEntropyValues report [native code]", () => {
    const ctx = evalScript(fingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(navigator.userAgentData.toJSON)")).toBe("function toJSON() { [native code] }");
    expect(str(ctx, "String(navigator.userAgentData.getHighEntropyValues)")).toBe("function getHighEntropyValues() { [native code] }");
  });

  it("the worker script carries the same shield", () => {
    const ctx = evalScript(workerFingerprintScript(DEFAULT_PROFILE));
    expect(str(ctx, "String(Function.prototype.toString)")).toBe("function toString() { [native code] }");
    expect(str(ctx, "String(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'userAgent').get)"))
      .toBe("function get userAgent() { [native code] }");
  });
});
