import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/* #551 first slice: cosmetic CSS selector injection from the Ghostery
   engine. The REAL engine builds from a filters string (FiltersEngine
  .parse) so the counting rides the engine's own filter-matched
   dispatch. transform.ts (the splice seam) is pinned in
   transform.test.ts, which only collects where the CI-generated
   rewriter_wasm artifact exists - this file keeps to the standalone
   cosmetics module so it can run in the wasm-less sandbox too. */

import { FiltersEngine } from "@ghostery/adblocker";
import {
  COSMETIC_STYLE_CAP,
  computeCosmeticStyles,
  cosmeticStyleTag,
  ghosteryCosmeticsForDocument,
} from "../cosmetics";
import {
  compileRules,
  rulesResetForTests,
  setRulesEnabled,
  setSiteOverrides,
} from "../rules";
import { DIAG } from "../diag";
import {
  configureGhostery,
  ghosteryBlock,
  ghosteryLoadInProgress,
} from "../ghostery";
import { streamAlive, streamDone } from "../streams-alive";

/* The transform splice itself is pinned in transform.test.ts (CI runs
   it with the real wasm glue; the missing rewriter_wasm artifact makes
   transform.ts unimportable in this sandbox, so this file keeps to the
   standalone cosmetics module). */

function engineFrom(filters: string, opts?: Parameters<typeof FiltersEngine.parse>[1]): FiltersEngine {
  return FiltersEngine.parse(filters, opts);
}

describe("computeCosmeticStyles (#551)", () => {
  it("a hostname hide rule compiles into the injected <style> with the selector", async () => {
    const eng = engineFrom("example.com##.banner-ad");
    const outcome = await computeCosmeticStyles(eng, "https://example.com/page");
    expect(outcome).not.toBeNull();
    expect(outcome!.applied).toBe(1);
    expect(outcome!.skipped).toBe(0);
    expect(outcome!.unsupported).toBe(0);
    expect(outcome!.truncated).toBe(false);
    expect(outcome!.styles).toContain(".banner-ad");
    const tag = cosmeticStyleTag(outcome!.styles);
    expect(tag.startsWith("<style data-zl-cosmetic>")).toBe(true);
    expect(tag.endsWith("</style>")).toBe(true);
    expect(tag).toContain(".banner-ad");
  });

  it("an exception rule suppresses the hide and the tag is empty", async () => {
    const eng = engineFrom("example.com##.banner-ad\nexample.com#@#.banner-ad");
    const outcome = await computeCosmeticStyles(eng, "https://example.com/page");
    expect(outcome!.applied).toBe(0);
    expect(outcome!.skipped).toBe(1);
    expect(outcome!.styles).not.toContain(".banner-ad");
    expect(cosmeticStyleTag(outcome!.styles)).toBe("");
  });

  it("a scriptlet is counted unsupported and nothing script-shaped is injected", async () => {
    const eng = engineFrom("example.com##+js(set-constant, a.b, 1)");
    const outcome = await computeCosmeticStyles(eng, "https://example.com/page");
    expect(outcome!.unsupported).toBe(1);
    expect(outcome!.applied).toBe(0);
    expect(outcome!.styles).toBe("");
    /* No scriptlet execution path exists in this slice: the injected
       markup is a <style> or nothing at all. */
    expect(cosmeticStyleTag(outcome!.styles)).not.toContain("<script");
  });

  it("an extended-selector rule is counted unsupported, not compiled", async () => {
    /* The engine drops extended selectors at parse unless
       loadExtendedSelectors is on (its default is false - the
       production prebuilt engine therefore loads none); with the flag
       the extended arm must surface as an unsupported count, never as
       an executed script. */
    const eng = engineFrom("example.com##.zap:has-text(watch)", { loadExtendedSelectors: true });
    const outcome = await computeCosmeticStyles(eng, "https://example.com/page");
    expect(outcome!.unsupported).toBe(1);
    expect(outcome!.applied).toBe(0);
    expect(cosmeticStyleTag(outcome!.styles)).not.toContain("<script");
  });

  it("the default engine config loads no extended selectors at all", async () => {
    const eng = engineFrom("example.com##.zap:has-text(watch)");
    const outcome = await computeCosmeticStyles(eng, "https://example.com/page");
    expect(outcome!.unsupported).toBe(0);
    expect(outcome!.applied).toBe(0);
    expect(outcome!.styles).toBe("");
  });

  it("the <style> splice cannot be escaped by a hostile selector text", () => {
    const tag = cosmeticStyleTag(".a{}</style><script>alert(1)</script>");
    expect(tag).not.toContain("</style><script>");
    expect(tag.startsWith("<style data-zl-cosmetic>")).toBe(true);
  });

  it("a stylesheet over the cap truncates and reports the flag", async () => {
    /* 8000 hostname-anchored hide rules: the compiled stylesheet
       (grouped selectors, ~10 bytes each) crosses the 64 KiB cap. */
    let filters = "";
    for (let i = 0; i < 8000; i++) filters += "big.example##.sel" + i + "\n";
    const eng = engineFrom(filters);
    const outcome = await computeCosmeticStyles(eng, "https://big.example/page");
    expect(outcome!.truncated).toBe(true);
    expect(outcome!.styles.length).toBe(COSMETIC_STYLE_CAP);
    expect(outcome!.applied).toBe(8000);
  });

  it("an unparsable document URL yields null without touching the engine", async () => {
    const eng = engineFrom("example.com##.banner-ad");
    await expect(computeCosmeticStyles(eng, "not a url")).resolves.toBeNull();
  });

  it("a class-anchored generic hide stays dormant without DOM features", async () => {
    /* getRulesFromDOM=false in this slice: the SW has no DOM at
       rewrite time, so class-anchored generics never match. */
    const eng = engineFrom("##.banner-ad");
    const outcome = await computeCosmeticStyles(eng, "https://any.example/page");
    expect(outcome!.applied).toBe(0);
    expect(outcome!.styles).toBe("");
  });
});

/* ---- The document-rewrite gate (ghosteryCosmeticsForDocument) -----
   Needs a LOADED engine behind the ghostery module singleton: prime it
   the way ghostery.test.ts does (idle-gated kick over a fake list
   fetch), with a real synthetic list that clears the #500 sanity
   floor. The synthetic list also carries a 8000-rule block for
   trunc.example so the truncation DIAG test can run against the same
   loaded engine. */

const PRIMED_FILTERS =
  Array.from({ length: 1200 }, (_, i) => "||ad" + i + ".example^").join("\n") +
  "\nexample.com##.primed\n" +
  "sub.example.com##.subprimed\n" +
  Array.from({ length: 8000 }, (_, i) => "trunc.example##.sel" + i).join("\n") +
  "\n";

async function primeEngine(): Promise<void> {
  configureGhostery((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = raw.endsWith("resources.json") ? "{}" : PRIMED_FILTERS;
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
  });
  /* #577: the kick gates on the first proxied body having settled. */
  streamAlive("https://page.example/doc.html");
  streamDone("https://page.example/doc.html");
  ghosteryBlock("https://x.example/ad.js", "script");
  await new Promise<void>((r) => setTimeout(r, 300));
  const pending = ghosteryLoadInProgress();
  if (pending) await pending;
}

describe("ghosteryCosmeticsForDocument gates (#551)", () => {
  beforeAll(async () => {
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: "https://engine.example", href: "https://engine.example/sw.js" },
    };
    await primeEngine();
  });

  beforeEach(() => {
    rulesResetForTests();
  });

  afterEach(() => {
    rulesResetForTests();
  });

  it("with everything enabled the primed hide rule is injected for the document", async () => {
    const tag = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/page", "document");
    expect(tag).toContain("data-zl-cosmetic");
    expect(tag).toContain(".primed");
  });

  it("a sub-frame document injects too (hostname-anchored rule)", async () => {
    const tag = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://sub.example.com/frame", "iframe");
    expect(tag).toContain(".subprimed");
  });

  it("a challenge-allowlisted host gets nothing", async () => {
    const rules = compileRules({ allow: [{ host: "hcaptcha.com" }] });
    const tag = await ghosteryCosmeticsForDocument(
      rules, "https://www.hcaptcha.com/challenge", "iframe");
    expect(tag).toBe("");
    /* Parent-domain matching, same grammar as the block evaluation. */
    const tag2 = await ghosteryCosmeticsForDocument(
      rules, "https://newassets.hcaptcha.com/captcha/v1/x", "iframe");
    expect(tag2).toBe("");
    /* A non-allowlisted host still injects with the same rules. */
    const tag3 = await ghosteryCosmeticsForDocument(
      rules, "https://example.com/page", "document");
    expect(tag3).toContain(".primed");
  });

  it("zl:adblock disabled means no cosmetics", async () => {
    setRulesEnabled(false);
    const tag = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/page", "document");
    expect(tag).toBe("");
    setRulesEnabled(true);
    const tag2 = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/page", "document");
    expect(tag2).toContain(".primed");
  });

  it("a per-site adblock:false override spares that host only", async () => {
    setSiteOverrides([{ host: "example.com", adblock: false }]);
    const off = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/page", "document");
    expect(off).toBe("");
    /* Subdomains inherit the override (longest host suffix wins). */
    const offSub = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://deep.sub.example.com/page", "document");
    expect(offSub).toBe("");
    /* A different host is untouched. */
    const other = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://other.example/page", "document");
    expect(other).toBe("");
    /* A host OUTSIDE the override keeps its own cosmetics... and one
       with a matching rule injects them. */
    setSiteOverrides([{ host: "other.example", adblock: false }]);
    const kept = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/page", "document");
    expect(kept).toContain(".primed");
  });

  it("one bounded REWRITE diag event per document with counts only", async () => {
    const baseline = DIAG.snapshot(0).lastSeq;
    await ghosteryCosmeticsForDocument(
      compileRules({}), "https://example.com/diag", "document");
    const events = DIAG.snapshot(baseline).events;
    const cosmetic = events.filter((e) => e.message.startsWith("ghostery cosmetic styles"));
    expect(cosmetic.length).toBe(1);
    expect(cosmetic[0]!.category).toBe("REWRITE");
    expect(cosmetic[0]!.severity).toBe("info");
    expect(cosmetic[0]!.message).toContain("1 applied");
    expect(cosmetic[0]!.message).toContain("0 unsupported");
    expect(cosmetic[0]!.message).not.toContain(".primed");
    /* A second document gets its own single event. */
    await ghosteryCosmeticsForDocument(
      compileRules({}), "https://sub.example.com/diag2", "iframe");
    const cosmetic2 = DIAG.snapshot(baseline).events.filter((e) => e.message.startsWith("ghostery cosmetic styles"));
    expect(cosmetic2.length).toBe(2);
    expect(cosmetic2[1]!.message).toContain("for sub_frame");
  });

  it("a silent document (nothing applies) emits no event", async () => {
    const baseline = DIAG.snapshot(0).lastSeq;
    await ghosteryCosmeticsForDocument(
      compileRules({}), "https://quiet.example/nothing", "document");
    const cosmetic = DIAG.snapshot(baseline).events.filter((e) => e.message.startsWith("ghostery cosmetic styles"));
    expect(cosmetic.length).toBe(0);
  });

  it("truncation emits the bounded counter with the cap size", async () => {
    const baseline = DIAG.snapshot(0).lastSeq;
    const tag = await ghosteryCosmeticsForDocument(
      compileRules({}), "https://trunc.example/page", "document");
    /* The tag exists (truncated head) and the event reports it. */
    expect(tag).toContain("data-zl-cosmetic");
    const cosmetic = DIAG.snapshot(baseline).events.filter((e) => e.message.startsWith("ghostery cosmetic styles"));
    expect(cosmetic.length).toBe(1);
    expect(cosmetic[0]!.message).toContain("truncated at " + COSMETIC_STYLE_CAP + " bytes");
    expect(cosmetic[0]!.message).toContain("8000 applied");
  });
});
