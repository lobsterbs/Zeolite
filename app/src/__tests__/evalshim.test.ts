import { describe, expect, it, vi } from "vitest";
import { applyEvalShim } from "../bootstrap/evalshim";

/* Fake realm: a native eval that records its calls, an optional
   currentScript src, and an injectable module loader. */
function makeWin(src?: string) {
  const calls: unknown[][] = [];
  const native = vi.fn((...a: unknown[]) => {
    calls.push(a);
    return "native-result";
  });
  const w: Record<string, unknown> = {
    eval: native,
    document: src === undefined ? {} : { currentScript: { src } },
  };
  return { w, calls, native };
}

describe("applyEvalShim (#726)", () => {
  it("installs nothing when the site gate is off", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "native", vi.fn());
    expect(w.eval).toBe(native);
    expect(w.__zlEvalShim).toBeUndefined();
  });

  it("installs nothing without a currentScript src", () => {
    const { w, native } = makeWin();
    const load = vi.fn();
    applyEvalShim(w, "virtual", load);
    expect(w.eval).toBe(native);
    expect(load).not.toHaveBeenCalled();
  });

  it("wraps eval and loads the sibling module once, derived from the bootstrap src", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    const load = vi.fn(() => Promise.resolve());
    applyEvalShim(w, "virtual", load);
    expect(w.eval).not.toBe(native);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("https://engine.host/zlsw/evalrw.js");
  });

  it("is once-per-realm", () => {
    const { w } = makeWin("https://engine.host/zlsw/bootstrap.js");
    const load = vi.fn(() => Promise.resolve());
    applyEvalShim(w, "virtual", load);
    applyEvalShim(w, "virtual", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("passes strings through unchanged before the renamer lands (fail-closed)", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "virtual", vi.fn(() => Promise.resolve()));
    const out = (w.eval as (s: string) => unknown)("location.origin");
    expect(out).toBe("native-result");
    expect(native).toHaveBeenCalledWith("location.origin");
  });

  it("renames string sources through __zlRG and passes the rest of the args", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "virtual", vi.fn(() => Promise.resolve()));
    w.__zlRG = (js: string) => js.replace("location", "__zl");
    const out = (w.eval as (...a: unknown[]) => unknown)("location.origin", "extra");
    expect(out).toBe("native-result");
    expect(native).toHaveBeenCalledWith("__zl.origin", "extra");
  });

  it("fails closed when the renamer throws", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "virtual", vi.fn(() => Promise.resolve()));
    w.__zlRG = () => {
      throw new Error("boom");
    };
    (w.eval as (s: string) => unknown)("location.origin");
    expect(native).toHaveBeenCalledWith("location.origin");
  });

  it("returns non-string arguments unchanged", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "virtual", vi.fn(() => Promise.resolve()));
    w.__zlRG = vi.fn();
    const obj = { code: 1 };
    const out = (w.eval as (...a: unknown[]) => unknown)(obj);
    expect(out).toBe("native-result");
    expect(w.__zlRG).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith(obj);
  });

  it("forwards property reads to the native callee (name, toString stay native-shaped)", () => {
    const { w, native } = makeWin("https://engine.host/zlsw/bootstrap.js");
    applyEvalShim(w, "virtual", vi.fn(() => Promise.resolve()));
    expect((w.eval as { name?: string }).name).toBe(native.name);
    /* Function.prototype.toString on a callable Proxy is spec-mandated
       to "function () { [native code] }", so a toString probe sees
       native shape (the stealth property, not a bug). */
    expect(String(w.eval)).toBe("function () { [native code] }");
  });
});

