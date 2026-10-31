import { describe, expect, it } from "vitest";
import { swScriptUrl } from "../engine";
import { parseTtfbDeadline } from "../transport";

/* #477 wedge-class test seam: the e2e shell shrinks the transport's
   first-byte deadline through a whitelisted ttfb param on the SW
   script URL. These gate the two pure helpers; the harness wiring is
   covered by the torture suite. */

describe("parseTtfbDeadline (worker side of the ttfb seam)", () => {
  it("returns undefined for an absent or empty search", () => {
    expect(parseTtfbDeadline("")).toBeUndefined();
    expect(parseTtfbDeadline("?url=x")).toBeUndefined();
  });

  it("reads the param alone or beside other params, with or without a leading ?", () => {
    expect(parseTtfbDeadline("ttfb=3000")).toBe(3000);
    expect(parseTtfbDeadline("?ttfb=3000")).toBe(3000);
    expect(parseTtfbDeadline("?url=x&ttfb=2500")).toBe(2500);
    expect(parseTtfbDeadline("url=x&ttfb=2500&y=z")).toBe(2500);
  });

  it("keeps the production default outside the clamp range", () => {
    expect(parseTtfbDeadline("?ttfb=999")).toBeUndefined();
    expect(parseTtfbDeadline("?ttfb=50000")).toBeUndefined();
    expect(parseTtfbDeadline("?ttfb=abc")).toBeUndefined();
    expect(parseTtfbDeadline("?ttfb=")).toBeUndefined();
  });

  it("accepts the clamp bounds inclusive", () => {
    expect(parseTtfbDeadline("?ttfb=1000")).toBe(1000);
    expect(parseTtfbDeadline("?ttfb=30000")).toBe(30000);
  });
});

describe("swScriptUrl (shell side of the ttfb seam)", () => {
  it("keeps the bare script URL when the param is absent", () => {
    expect(swScriptUrl("")).toBe("/sw.js");
    expect(swScriptUrl("?url=http://x/")).toBe("/sw.js");
  });

  it("propagates a numeric param and drops garbage", () => {
    expect(swScriptUrl("?ttfb=3000")).toBe("/sw.js?ttfb=3000");
    expect(swScriptUrl("?url=http://x/&ttfb=2500")).toBe("/sw.js?ttfb=2500");
    expect(swScriptUrl("?ttfb=abc")).toBe("/sw.js");
    expect(swScriptUrl("?ttfb=")).toBe("/sw.js");
  });
});
