import { describe, expect, it } from "vitest";

/* #554 acceptance: unit coverage for the TS-side import map layer -
   the incremental document scanner, the per-page registry, and the
   bare-specifier resolver the module-worker serve seams use. */

import {
  IMPORTMAP_BODY_CAP,
  IMPORTMAP_ENTRIES_CAP,
  IMPORTMAP_PAGES_CAP,
  IMPORTMAP_SCOPES_CAP,
  IMPORTMAP_SCAN_TEXT_MAX,
  importmapNote,
  importmapReset,
  importmapScanner,
  newImportmapRegistry,
  pageKeyOf,
  resolveBareImport,
  resolveBareImportFor,
} from "../importmaps";

describe("pageKeyOf", () => {
  it("strips fragments and resolves relative URLs against the origin", () => {
    expect(pageKeyOf("https://page.host/app#frag", "https://engine.host")).toBe("https://page.host/app");
    expect(pageKeyOf("/app", "https://engine.host")).toBe("https://engine.host/app");
    expect(pageKeyOf("https://page.host/app#only", "https://engine.host")).toBe("https://page.host/app");
  });

  it("returns null for unparseable input", () => {
    expect(pageKeyOf("http://[", "https://engine.host")).toBeNull();
  });
});

describe("importmapScanner", () => {
  it("captures one import map body across arbitrary chunk boundaries", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    const doc = '<html><head><script type="importmap">{"imports":{}}</script></head></html>';
    for (const piece of [doc.slice(0, 30), doc.slice(30, 44), doc.slice(44)]) scan.feed(piece);
    expect(bodies).toEqual(['{"imports":{}}']);
  });

  it("captures every import map and ignores plain and module scripts", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    scan.feed("<script>var x = 1;</script>");
    scan.feed('<script type="module">import "a";</script>');
    scan.feed('<script type="importmap">{"imports":{"a":"https://x/1"}}</script>');
    scan.feed("<script type='importmap'>{\"imports\":{\"b\":\"https://x/2\"}}</script>");
    expect(bodies).toEqual(['{"imports":{"a":"https://x/1"}}', '{"imports":{"b":"https://x/2"}}']);
  });

  it("matches quoted, single-quoted, spaced and unquoted type attributes", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    scan.feed('<script type = "importmap">A</script>');
    scan.feed("<script type='importmap' async>B</script>");
    scan.feed("<script type=importmap>C</script>");
    expect(bodies).toEqual(["A", "B", "C"]);
  });

  it("does not treat a data-type attribute as the script type", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    scan.feed('<script data-type="importmap">D</script>');
    scan.feed('<script type="importmap">E</script>');
    expect(bodies).toEqual(["E"]);
  });

  it("drops a map whose body crosses the cap (the note-time gate, single chunk)", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    const big = "x".repeat(IMPORTMAP_BODY_CAP + 1);
    /* Single chunk: the whole body and its close tag arrive together,
       so the truncation gate at note time is the only guard. */
    scan.feed('<script type="importmap">' + big + "</script>");
    /* A body past the cap also exhausts the scan-text bound, so the
       scanner stops for the whole document. */
    expect(bodies).toEqual([]);
  });

  it("stops after the scan-text bound: a later map is never noted", () => {
    const bodies: string[] = [];
    const scan = importmapScanner((b) => bodies.push(b));
    scan.feed("j".repeat(IMPORTMAP_SCAN_TEXT_MAX + 1));
    scan.feed('<script type="importmap">late</script>');
    expect(bodies).toEqual([]);
  });
});

describe("importmapNote", () => {
  it("records only valid imports objects and merges a re-noted page (first mapping wins)", () => {
    const reg = newImportmapRegistry();
    importmapNote(reg, "https://page.host/app", "not json");
    importmapNote(reg, "https://page.host/app", "[]");
    importmapNote(reg, "https://page.host/app", '{"imports":[]}');
    expect(reg.pages.size).toBe(0);
    importmapNote(reg, "https://page.host/app", '{"imports":{"react":"https://esm.sh/react"}}');
    expect(reg.pages.size).toBe(1);
    /* A second map within the same document: new keys merge; a
       redefined key keeps the FIRST mapping (direct-Chromium probe:
       the later duplicate is dropped with a console warning). */
    importmapNote(reg, "https://page.host/app", '{"imports":{"vue":"https://esm.sh/vue","react":"https://esm.sh/react-19"}}');
    expect(reg.pages.size).toBe(1);
    expect(resolveBareImport(reg, "https://page.host/app", "vue")).toBe("https://esm.sh/vue");
    expect(resolveBareImport(reg, "https://page.host/app", "react")).toBe("https://esm.sh/react");
  });

  it("importmapReset forgets the page so a re-served document rebuilds fresh", () => {
    const reg = newImportmapRegistry();
    importmapNote(reg, "https://page.host/app", '{"imports":{"react":"https://esm.sh/react"}}');
    importmapReset(reg, "https://page.host/app");
    expect(reg.pages.has("https://page.host/app")).toBe(false);
    expect(resolveBareImport(reg, "https://page.host/app", "react")).toBeNull();
    importmapNote(reg, "https://page.host/app", '{"imports":{"vue":"https://esm.sh/vue"}}');
    expect(resolveBareImport(reg, "https://page.host/app", "react")).toBeNull();
    expect(resolveBareImport(reg, "https://page.host/app", "vue")).toBe("https://esm.sh/vue");
  });

  it("records a scopes-only map and skips invalid rules", () => {
    const reg = newImportmapRegistry();
    /* Invalid shapes: imports not an object, scopes not an object,
       a bare-specifier VALUE (Chromium ignores such rules), an
       empty fallback array. */
    importmapNote(reg, "https://page.host/app", '{"scopes":"x"}');
    expect(reg.pages.size).toBe(0);
    importmapNote(reg, "https://page.host/app", JSON.stringify({
      imports: { bad: "barevalue", empty: [], ok: "https://x/1" },
      scopes: { "/sub/": { bare: "noscheme", ok: "https://x/2" } },
    }));
    expect(reg.pages.size).toBe(1);
    const page = reg.pages.get("https://page.host/app")!;
    expect(page.imports.get("ok")).toBe("https://x/1");
    expect(page.imports.has("bad")).toBe(false);
    expect(page.imports.has("empty")).toBe(false);
    expect(page.scopes.get("https://page.host/sub/")?.get("ok")).toBe("https://x/2");
    expect(page.scopes.get("https://page.host/sub/")?.has("bare")).toBe(false);
  });

  it("normalizes scope keys: relative keys resolve against the page, missing slash appended", () => {
    const reg = newImportmapRegistry();
    importmapNote(reg, "https://page.host/app/page.html", JSON.stringify({
      scopes: { "sub/": { a: "https://x/a" }, "https://other.host/deep": { b: "https://x/b" } },
    }));
    const page = reg.pages.get("https://page.host/app/page.html")!;
    expect(page.scopes.has("https://page.host/app/sub/")).toBe(true);
    expect(page.scopes.has("https://other.host/deep/")).toBe(true);
  });

  it("ignores a scope whose key cannot normalize against the page", () => {
    const reg = newImportmapRegistry();
    importmapNote(reg, "https://page.host/app", '{"scopes":{"https://[bad":{"a":"https://x/a"}}}');
    const page = reg.pages.get("https://page.host/app")!;
    expect(page.scopes.size).toBe(0);
  });

  it("keeps the scopes cap and the first registration of a scope", () => {
    const reg = newImportmapRegistry();
    for (let i = 0; i < IMPORTMAP_SCOPES_CAP + 3; i++) {
      importmapNote(reg, "https://page.host/app", '{"scopes":{"/s' + i + '/":{"a":"https://x/' + i + '"}}}');
    }
    const page = reg.pages.get("https://page.host/app")!;
    expect(page.scopes.size).toBe(IMPORTMAP_SCOPES_CAP);
    /* The first IMPORTMAP_SCOPES_CAP scopes won; later ones dropped. */
    expect(page.scopes.has("https://page.host/s0/")).toBe(true);
    expect(page.scopes.has("https://page.host/s" + (IMPORTMAP_SCOPES_CAP + 2) + "/")).toBe(false);
  });

  it("keeps only entries-cap keys and evicts the oldest page at the pages cap", () => {
    const reg = newImportmapRegistry();
    const many: string[] = [];
    for (let i = 0; i < IMPORTMAP_ENTRIES_CAP + 2; i++) many.push('"k' + i + '":"https://x/' + i + '"');
    importmapNote(reg, "https://page.host/1", '{"imports":{' + many.join(",") + "}}");
    const m = reg.pages.get("https://page.host/1")!;
    expect(m.imports.size).toBe(IMPORTMAP_ENTRIES_CAP);
    for (let p = 0; p < IMPORTMAP_PAGES_CAP + 1; p++) {
      importmapNote(reg, "https://page.host/p" + p, '{"imports":{"a":"https://x/a"}}');
    }
    expect(reg.pages.size).toBe(IMPORTMAP_PAGES_CAP);
    expect(reg.pages.has("https://page.host/1")).toBe(false);
    expect(reg.pages.has("https://page.host/p1")).toBe(true);
  });
});

describe("resolveBareImport", () => {
  const reg = newImportmapRegistry();
  importmapNote(reg, "https://page.host/app", JSON.stringify({
    imports: {
      lodash: "https://esm.sh/lodash@4",
      "react-dom/": "https://esm.sh/react-dom/",
      "react/": "https://esm.sh/react/",
      blocked: null,
      fallback: ["https://dead.invalid/x", "https://live.host/y"],
      opaque: "data:text/javascript,x",
    },
  }));

  it("resolves exact keys, prefix keys with remainder, and the longest prefix", () => {
    expect(resolveBareImport(reg, "https://page.host/app", "lodash")).toBe("https://esm.sh/lodash@4");
    expect(resolveBareImport(reg, "https://page.host/app", "react-dom/client")).toBe("https://esm.sh/react-dom/client");
    expect(resolveBareImport(reg, "https://page.host/app", "react/jsx-runtime")).toBe("https://esm.sh/react/jsx-runtime");
  });

  it("returns null for unknown pages, unknown keys, the block form and non-http targets", () => {
    expect(resolveBareImport(reg, "https://other.host/app", "lodash")).toBeNull();
    expect(resolveBareImport(reg, "https://page.host/app", "nope")).toBeNull();
    expect(resolveBareImport(reg, "https://page.host/app", "blocked")).toBeNull();
    expect(resolveBareImport(reg, "https://page.host/app", "opaque")).toBeNull();
  });

  it("returns the first http(s) entry of an array target (no probing)", () => {
    expect(resolveBareImport(reg, "https://page.host/app", "fallback")).toBe("https://dead.invalid/x");
  });
});

describe("resolveBareImportFor (scope-aware)", () => {
  /* Mirrors the direct-Chromium probe semantics: a scoped importer
     resolves through the longest matching scope, cascading to the
     next scope and then top-level on a miss; a matched rule (block
     or unresolvable) decides; scope maps never leak upward. */
  const reg = newImportmapRegistry();
  importmapNote(reg, "https://page.host/app", JSON.stringify({
    imports: { a: "https://x/top-a", onlytop: "https://x/top-only", blocked: null },
    scopes: {
      "/sub/": { a: "https://x/sub-a", mid: "https://x/mid" },
      "/sub/deep/": { a: "https://x/deep-a" },
      "/other/": { blocked: null },
    },
  }));

  it("the longest matching scope wins for a deep importer", () => {
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/sub/deep/mod.mjs", "a"))
      .toBe("https://x/deep-a");
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/sub/mod.mjs", "a"))
      .toBe("https://x/sub-a");
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/root.mjs", "a"))
      .toBe("https://x/top-a");
  });

  it("cascades from the longest scope to shorter scopes on a miss, then top-level", () => {
    /* mid lives only in /sub/; the /sub/deep/ importer still finds it. */
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/sub/deep/mod.mjs", "mid"))
      .toBe("https://x/mid");
    /* onlytop lives only at top level; a scoped importer falls back. */
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/sub/mod.mjs", "onlytop"))
      .toBe("https://x/top-only");
  });

  it("scope maps never leak upward: a root importer fails on a scope-only key", () => {
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/root.mjs", "mid")).toBeNull();
  });

  it("a matched block form decides and never falls back to a less specific map", () => {
    /* /other/ blocks "blocked" outright. */
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/other/mod.mjs", "blocked"))
      .toBeNull();
    /* A top-level block still blocks a scoped importer (no scope rule). */
    expect(resolveBareImportFor(reg, "https://page.host/app", "https://page.host/sub/mod.mjs", "blocked"))
      .toBeNull();
  });

  it("unknown page, empty importer, and non-matching scope all reduce to top-level", () => {
    expect(resolveBareImportFor(reg, "https://other.host/app", "https://page.host/sub/mod.mjs", "a")).toBeNull();
    expect(resolveBareImportFor(reg, "https://page.host/app", null, "a")).toBe("https://x/top-a");
    expect(resolveBareImportFor(reg, "https://page.host/app", "", "a")).toBe("https://x/top-a");
  });

  it("resolves prefix keys inside a scope with the remainder", () => {
    const reg2 = newImportmapRegistry();
    importmapNote(reg2, "https://page.host/app", JSON.stringify({
      scopes: { "/sub/": { "util/": "https://x/u/" } },
    }));
    expect(resolveBareImportFor(reg2, "https://page.host/app", "https://page.host/sub/w.mjs", "util/helper.js"))
      .toBe("https://x/u/helper.js");
  });
});
