import { beforeEach, describe, expect, it } from "vitest";
import { classifyForeign, preflightHeaders } from "../foreign";
import { encodeDest, setScheme } from "../codec";

/* Issue #34 decision table. The SW owns the async client lookup and
   hands the classifier two facts: the client's own URL (when it could
   be resolved) and whether the client has a #33 virtual context (a
   proxied page, or a worker the engine served). Everything here is
   pure, so the whole policy is pinned by unit tests. */
const ENGINE = "https://engine.host";
const PAGE = ENGINE + encodeDest("https://page.example/dir/page.html");
const HOST_APP = ENGINE + "/index.html";

function ask(over: Partial<Parameters<typeof classifyForeign>[0]> = {}) {
  return classifyForeign({
    requestUrl: "https://api.example.com/v1/data",
    engineOrigin: ENGINE,
    method: "GET",
    preflight: false,
    clientUrl: PAGE,
    ...over,
  });
}

describe("classifyForeign (#34)", () => {
  beforeEach(() => {
    setScheme("/j/");
  });

  it("a proxied page's request routes through the engine", () => {
    expect(ask()).toBe("route");
  });

  it("a client with a virtual context routes even without a decodable URL (engine-served worker)", () => {
    expect(ask({ clientUrl: undefined, hasContext: true })).toBe("route");
  });

  it("a host-app page's cross-origin traffic is its own business (passthrough)", () => {
    expect(ask({ clientUrl: HOST_APP })).toBe("passthrough");
    expect(ask({ clientUrl: undefined })).toBe("passthrough"); // unknown client: fail open for the host app, never engine work
  });

  it("only a proxied client's OPTIONS + access-control-request-method is a preflight", () => {
    expect(ask({ method: "OPTIONS", preflight: true })).toBe("preflight");
    expect(ask({ method: "OPTIONS", preflight: true, clientUrl: HOST_APP })).toBe("passthrough");
    expect(ask({ method: "OPTIONS", preflight: true, clientUrl: undefined, hasContext: false })).toBe("passthrough");
    expect(ask({ method: "OPTIONS" })).toBe("route"); // plain OPTIONS: a real request, not a preflight
    expect(ask({ method: "POST", preflight: true })).toBe("route"); // preflight flag without OPTIONS is not a preflight
  });

  it("the classifier is total: opaque, engine-origin and unparseable URLs never become engine work", () => {
    expect(ask({ requestUrl: "blob:https://engine.host/uuid" })).toBe("passthrough");
    expect(ask({ requestUrl: ENGINE + "/j/whatever", hasContext: true })).toBe("passthrough"); // same-origin never reaches here; safe anyway
    expect(ask({ requestUrl: "::not a url::" })).toBe("passthrough");
  });
});

describe("preflightHeaders (#34)", () => {
  it("grants exactly the method and headers the page asked for", () => {
    const h = preflightHeaders({
      requestMethod: "PATCH",
      requestHeaders: "content-type, x-custom",
      credentials: "same-origin",
      engineOrigin: ENGINE,
    });
    expect(h["access-control-allow-origin"]).toBe(ENGINE);
    expect(h["access-control-allow-methods"]).toBe("PATCH");
    expect(h["access-control-allow-headers"]).toBe("content-type, x-custom");
    expect(h["access-control-max-age"]).toBe("86400");
    expect(h["access-control-allow-credentials"]).toBeUndefined();
  });

  it("no header grant when nothing was asked; GET default; credentials only on include", () => {
    const bare = preflightHeaders({
      requestMethod: null,
      requestHeaders: null,
      credentials: "omit",
      engineOrigin: ENGINE,
    });
    expect(bare["access-control-allow-methods"]).toBe("GET");
    expect(bare["access-control-allow-headers"]).toBeUndefined();
    expect(bare["access-control-allow-credentials"]).toBeUndefined();

    const cred = preflightHeaders({
      requestMethod: "POST",
      requestHeaders: null,
      credentials: "include",
      engineOrigin: ENGINE,
    });
    expect(cred["access-control-allow-credentials"]).toBe("true");
  });
});
