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
   executed). #517: the bridge and the scripting listener are served
   as invoked IIFEs taking (cfg, auth); the channel secret must be an
   argument, never a global a page script could read. */

function bridgeBody(cfg: unknown, auth: string): string {
  return BRIDGE_SOURCE + ")(" + JSON.stringify(cfg) + "," + JSON.stringify(auth) + ");";
}

describe("served extension sources parse", () => {
  it("bridge payload compiles in its invoked (cfg, auth) form", () => {
    const body = bridgeBody(
      {
        ext: "a".repeat(32),
        js: ["/zl-cs/" + "a".repeat(32) + "/cs.js"],
        css: [],
        runAt: "document_idle",
      },
      "channel-secret",
    );
    expect(() => new Function(body)).not.toThrow();
  });

  it("bridge keeps the strict-line newline as a two-character sequence", () => {
    /* The inner new Function must receive the escape sequence, not a
       real newline: a real one splits the string literal and the
       content script dies at parse. */
    expect(BRIDGE_SOURCE).toContain("'\"use strict\";\\n' + code");
  });

  it("bridge takes cfg and auth as arguments, never a global", () => {
    expect(BRIDGE_SOURCE.startsWith("(function (cfg, auth) {")).toBe(true);
    expect(BRIDGE_SOURCE).not.toContain("ZL_CS_CFG");
    expect(BRIDGE_SOURCE).toContain("auth: auth");
  });

  it("scripting listener compiles in its invoked (auth) form", () => {
    expect(LISTENER_SOURCE.startsWith("(function (auth) {")).toBe(true);
    expect(LISTENER_SOURCE).toContain("auth: auth");
    expect(() => new Function(LISTENER_SOURCE + ")(\"channel-secret\");")).not.toThrow();
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
