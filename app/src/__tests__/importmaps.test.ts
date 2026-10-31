import { describe, expect, it } from "vitest";

/* #554 acceptance: unit coverage for the TS-side import map layer -
   the incremental document scanner, the per-page registry, and the
   bare-specifier resolver the module-worker serve seams use. */

import {
  IMPORTMAP_BODY_CAP,
  IMPORTMAP_ENTRIES_CAP,
  IMPORTMAP_PAGES_CAP,
  IMPORTMAP_SCAN_TEXT_MAX,
  importmapNote,
  importmapScanner,
  newImportmapRegistry,
  pageKeyOf,
  resolveBareImport,
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
  it("records only valid imports objects and replaces a re-noted page", () => {
    const reg = newImportmapRegistry();
    importmapNote(reg, "https://page.host/app", "not json");
    importmapNote(reg, "https://page.host/app", "[]");
    importmapNote(reg, "https://page.host/app", '{"imports":[]}');
    expect(reg.pages.size).toBe(0);
    importmapNote(reg, "https://page.host/app", '{"imports":{"react":"https://esm.sh/react"}}');
    expect(reg.pages.size).toBe(1);
    importmapNote(reg, "https://page.host/app", '{"imports":{"vue":"https://esm.sh/vue"}}');
    expect(reg.pages.size).toBe(1);
    expect(resolveBareImport(reg, "https://page.host/app", "vue")).toBe("https://esm.sh/vue");
    expect(resolveBareImport(reg, "https://page.host/app", "react")).toBeNull();
  });

  it("keeps only entries-cap keys and evicts the oldest page at the pages cap", () => {
    const reg = newImportmapRegistry();
    const many: string[] = [];
    for (let i = 0; i < IMPORTMAP_ENTRIES_CAP + 2; i++) many.push('"k' + i + '":"https://x/' + i + '"');
    importmapNote(reg, "https://page.host/1", '{"imports":{' + many.join(",") + "}}");
    const m = reg.pages.get("https://page.host/1")!;
    expect(m.size).toBe(IMPORTMAP_ENTRIES_CAP);
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
