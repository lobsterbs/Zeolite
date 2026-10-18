import { describe, expect, it } from "vitest";
import { parseKdl } from "../kdl";
import { rulesFromNodes, ruleFor } from "../siteconfig";

/* #265: siteconfig rule keys were compared case-sensitively and
   malformed hosts (URLs, patterns, empty labels) could survive parse
   and shadow a real rule. Keys are now normalized at parse time. */

describe("siteconfig host key normalization (#265)", () => {
  it("lowercases mixed-case site keys so ruleFor matches", () => {
    const rules = rulesFromNodes(parseKdl('site "Coherent.Example" { block "ads.example" }'));
    expect(Object.keys(rules)).toEqual(["coherent.example"]);
    expect(ruleFor(rules, "https://www.coherent.example/x")).toEqual({
      block: ["ads.example"],
    });
  });

  it("rejects non-host keys instead of keeping dead entries", () => {
    const rules = rulesFromNodes(
      parseKdl([
        'site "https://evil.example/" { inject "x.js" }',
        'site "*.wildcard.example" { inject "y.js" }',
        'site "ok.example" { block "b" }',
        'site "" { block "never" }',
        'site "-leadingdash.example" { block "never" }',
      ].join("\n")),
    );
    expect(Object.keys(rules)).toEqual(["ok.example"]);
  });
});
