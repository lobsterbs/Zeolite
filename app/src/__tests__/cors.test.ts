import { describe, expect, it } from "vitest";
import {
  CORS_RESPONSE_HEADERS,
  applyEngineCors,
  engineCorsValues,
} from "../cors";

describe("engineCorsValues (issue #2)", () => {
  it("uncredentialed requests get the wildcard", () => {
    expect(engineCorsValues("https://engine.dev", "omit")).toEqual({
      "access-control-allow-origin": "*",
    });
  });

  it("credentialed requests get the engine origin (wildcards are illegal with credentials)", () => {
    for (const cred of ["include", "same-origin"]) {
      expect(engineCorsValues("https://engine.dev", cred)).toEqual({
        "access-control-allow-origin": "https://engine.dev",
        "access-control-allow-credentials": "true",
      });
    }
  });
});

describe("applyEngineCors", () => {
  it("replaces a preserved target ACAO with engine facts", () => {
    const h = new Headers({
      "access-control-allow-origin": "https://excalidraw.com",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "etag",
      "content-type": "application/javascript",
    });
    applyEngineCors(h, "https://engine.dev", "same-origin");
    expect(h.get("access-control-allow-origin")).toBe("https://engine.dev");
    expect(h.get("access-control-allow-credentials")).toBe("true");
    expect(h.get("access-control-expose-headers")).toBeNull();
    expect(h.get("content-type")).toBe("application/javascript");
  });

  it("every target CORS header is dropped before the engine values land", () => {
    const h = new Headers();
    for (const k of CORS_RESPONSE_HEADERS) h.set(k, "target-fact");
    applyEngineCors(h, "https://engine.dev", "omit");
    expect(h.get("access-control-allow-origin")).toBe("*");
    for (const k of CORS_RESPONSE_HEADERS) {
      if (k !== "access-control-allow-origin") expect(h.get(k)).toBeNull();
    }
  });

  it("sets engine CORS facts even when the target sent none (module scripts fetch cors-mode)", () => {
    const h = new Headers({ "content-type": "text/css" });
    applyEngineCors(h, "https://engine.dev", "include");
    expect(h.get("access-control-allow-origin")).toBe("https://engine.dev");
    expect(h.get("access-control-allow-credentials")).toBe("true");
  });
});
