import { beforeEach, describe, expect, it } from "vitest";
import {
  BODY_LIMIT,
  intercept,
  resetInterceptorsForTests,
  runRequestInterception,
  runResponseInterception,
  type InterceptRequestCtx,
} from "../intercept";

beforeEach(() => resetInterceptorsForTests());

const CTX: InterceptRequestCtx = {
  url: "https://example.com/x",
  method: "GET",
  rtype: "fetch",
  headers: {},
};

describe("intercept request kinds", () => {
  it("handlers can block", () => {
    intercept("request", () => ({ block: true }));
    expect(runRequestInterception(["request"], CTX).block).toBe(true);
  });

  it("first url rewrite wins", () => {
    intercept("request", () => ({ url: "https://first/" }));
    intercept("request", () => ({ url: "https://second/" }));
    expect(runRequestInterception(["request"], CTX).url).toBe("https://first/");
  });

  it("header maps merge, later wins per key", () => {
    intercept("request", () => ({ headers: { a: "1" } }));
    intercept("request", () => ({ headers: { b: "2", a: "3" } }));
    expect(runRequestInterception(["request"], CTX).headers).toEqual({ a: "3", b: "2" });
  });

  it("a handler only fires for the kinds the SW dispatches", () => {
    let navigationSaw = false;
    intercept("navigation", () => {
      navigationSaw = true;
      return { block: true };
    });
    // document-mode dispatch includes "navigation"
    expect(
      runRequestInterception(["request", "navigation"], { ...CTX, rtype: "document" }).block,
    ).toBe(true);
    // subresource dispatch does not
    expect(runRequestInterception(["request", "fetch"], CTX).block).toBeUndefined();
    expect(navigationSaw).toBe(true);
  });

  it("a throwing handler is skipped", () => {
    intercept("request", () => {
      throw new Error("boom");
    });
    intercept("request", () => ({ block: true }));
    expect(runRequestInterception(["request"], CTX).block).toBe(true);
  });

  it("unregister works", () => {
    const off = intercept("request", () => ({ block: true }));
    off();
    expect(runRequestInterception(["request"], CTX).block).toBeUndefined();
  });
});

describe("intercept response kind", () => {
  it("headers merge and first body transform wins", () => {
    intercept("response", () => ({ headers: { "x-a": "1" }, body: (t: string) => t + "1" }));
    intercept("response", () => ({ body: () => "second" }));
    const r = runResponseInterception({
      url: "https://example.com/",
      status: 200,
      rtype: "fetch",
      headers: {},
    });
    expect(r.headers).toEqual({ "x-a": "1" });
    expect(r.body?.("x")).toBe("x1");
  });

  it("observers returning nothing are fine", () => {
    intercept("response", () => undefined);
    expect(
      runResponseInterception({ url: "u", status: 204, rtype: "other", headers: {} }),
    ).toEqual({});
  });

  it("body size gate is a sane constant", () => {
    expect(BODY_LIMIT).toBe(512 * 1024);
  });
});
