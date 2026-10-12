import { describe, expect, it } from "vitest";
import { BRIDGE_SOURCE } from "../bridge";
import { LISTENER_SOURCE } from "../scripting";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";

/* #150 gate: every served extension payload must compile. These
   sources are template literals or string arrays emitted verbatim
   into served JavaScript, so an unescaped escape sequence inside them
   becomes a real control character at build time and the served
   script dies with a SyntaxError before any content script runs
   (that exact bug shipped: BRIDGE_SOURCE had a bare newline escape
   where it needed a doubled one, so no declared content script ever
   executed). */
describe("served extension sources parse", () => {
  it("bridge payload compiles with its cfg prefix", () => {
    const body =
      "var ZL_CS_CFG = " +
      JSON.stringify({
        ext: "a".repeat(32),
        js: ["/zl-cs/" + "a".repeat(32) + "/cs.js"],
        css: [],
        runAt: "document_idle",
      }) +
      ";\n" +
      BRIDGE_SOURCE;
    expect(() => new Function(body)).not.toThrow();
  });

  it("bridge keeps the strict-line newline as a two-character sequence", () => {
    /* The inner new Function must receive the escape sequence, not a
       real newline: a real one splits the string literal and the
       content script dies at parse. */
    expect(BRIDGE_SOURCE).toContain("'\"use strict\";\\n' + code");
  });

  it("scripting listener compiles", () => {
    expect(() => new Function(LISTENER_SOURCE)).not.toThrow();
  });

  it("extension-page bridge compiles with its cfg prefix", () => {
    const body =
      "var ZL_PAGE_CFG = " +
      JSON.stringify({ ext: "a".repeat(32), base: "/zl-ext/" + "a".repeat(32), calls: [] }) +
      ";\n" +
      PAGE_BRIDGE_SOURCE;
    expect(() => new Function(body)).not.toThrow();
  });
});
