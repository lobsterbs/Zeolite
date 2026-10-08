import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, encodeDest, encodeNavHandle, setRouteKey, setScheme } from "../codec";
import { derefSelfRoute } from "../request";

/* #112 follow-up: page JS that builds <real origin> + location.pathname
   sends the engine route token upstream as the path. The engine decodes
   its own token and fetches the decoded page instead. */
const ENGINE = "https://proxy.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("derefSelfRoute (#112 follow-up)", () => {
  it("dereferences an embedded keyed route token to the decoded page", () => {
    setRouteKey(KEY);
    const route = encodeDest("https://www.google.com/sorry/index");
    expect(derefSelfRoute("https://www.google.com" + route + "?x=1", ENGINE))
      .toBe("https://www.google.com/sorry/index?x=1");
  });

  it("dereferences an embedded nav handle inside its TTL", () => {
    setRouteKey(KEY);
    const tok = encodeNavHandle("https://www.google.com/sorry/index");
    if (tok === null) throw new Error("nav handle mint failed");
    expect(derefSelfRoute("https://www.google.com/__zl_navh__/" + tok + "?x=1", ENGINE))
      .toBe("https://www.google.com/sorry/index?x=1");
  });

  it("keeps the decoded page's own query when the built URL has none", () => {
    setRouteKey(KEY);
    const route = encodeDest("https://www.google.com/sorry/index?q=hi");
    expect(derefSelfRoute("https://www.google.com" + route, ENGINE))
      .toBe("https://www.google.com/sorry/index?q=hi");
  });

  it("leaves a real upstream path that merely looks like a route alone", () => {
    setRouteKey(KEY);
    const t = "https://www.google.com/j/not-a-token?x=1";
    expect(derefSelfRoute(t, ENGINE)).toBe(t);
  });

  it("never dereferences across origins", () => {
    setRouteKey(KEY);
    const route = encodeDest("https://example.com/page");
    const t = "https://www.google.com" + route;
    expect(derefSelfRoute(t, ENGINE)).toBe(t);
  });

  it("leaves engine-origin URLs, non-http schemes and garbage alone", () => {
    expect(derefSelfRoute(ENGINE + "/j/whatever", ENGINE)).toBe(ENGINE + "/j/whatever");
    expect(derefSelfRoute("ftp://x/j/a", ENGINE)).toBe("ftp://x/j/a");
    expect(derefSelfRoute("not a url", ENGINE)).toBe("not a url");
  });
});
