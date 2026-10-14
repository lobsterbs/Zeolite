import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { maskedScriptCount, maskedScriptResponse, needsScriptBodyMask, recordMaskedScript } from "../request";

/* 2026-10-14 report: the #158/#159 script-body mask stays, but every
   masked response is counted and logged. The regression harness proves
   the mask ONLY fires on the wrong-URL shapes: a healthy module graph
   (JS answered to a script destination) never trips it. */

describe("script-body mask (wrong-URL visibility)", () => {
  it("masks HTML and CSS on script and worker destinations (#158/#159 shapes)", () => {
    expect(needsScriptBodyMask("script", "", "text/html; charset=utf-8")).toBe(true);
    expect(needsScriptBodyMask("script", "", "text/css")).toBe(true);
    expect(needsScriptBodyMask("empty", "worker", "text/html")).toBe(true);
    expect(needsScriptBodyMask("empty", "sharedworker", "text/css")).toBe(true);
  });

  it("never masks the healthy shapes: JS to script, any body to other destinations", () => {
    expect(needsScriptBodyMask("script", "", "application/javascript")).toBe(false);
    expect(needsScriptBodyMask("empty", "worker", "text/javascript")).toBe(false);
    expect(needsScriptBodyMask("script", "", "")).toBe(false);
    expect(needsScriptBodyMask("image", "", "text/html")).toBe(false);
    expect(needsScriptBodyMask("empty", "iframe", "text/html")).toBe(false);
  });

  it("masked response: JS-typed honest comment with the upstream status and type", async () => {
    const r = maskedScriptResponse(200, "text/html; charset=utf-8");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    await expect(r.text()).resolves.toBe("/* upstream 200 text/html */");
  });

  it("every masked response is counted", () => {
    const before = maskedScriptCount();
    recordMaskedScript("https://x.example/app/chunk.js", "https://engine/zl/route", "https://x.example/");
    recordMaskedScript("https://x.example/app/2.js", "", "https://x.example/");
    expect(maskedScriptCount()).toBe(before + 2);
  });
});
