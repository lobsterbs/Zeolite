/* Zeolite in-page finder, issue #29.

   This module is a PAGE-side artifact, not service-worker code: the
   SW ships its compiled bundle (dist/finder.js, a sibling of sw.js)
   to the proxied document inside the first zl:findLoad message, and
   the bootstrap loader (src/bootstrap/findload.ts) evaluates it
   once per document. The service worker cannot walk page DOM, so
   the client find bar drives the search through the zl:find control
   message (dest-addressed, like the content-script bridges) and the
   results flow back on the transferred MessageChannel port.

   Coverage, honestly: text nodes of the document plus every OPEN
   shadow root (closed roots are unreachable from script by
   definition); script/style/noscript/template text is skipped.
   Highlighting uses the CSS Custom Highlight API - zero DOM
   mutation - and is reported as "none" on engines without it, which
   still get exact counts, ordinals and scroll-to-match. A page CSP
   that blocks eval refuses the loader: no find, honestly, the same
   limitation the scripting bridge already documents.

   What window.find() could not do: standard interfaces, shadow DOM
   coverage, and an accurate n-of-m. */

import { buildRegex, matchPositions, stepOrdinal } from "./find-core";

interface FindLoadMessage {
  type: "zl:findLoad";
  dest: string;
  cmd: "find" | "next" | "prev" | "clear";
  pattern?: string;
  options?: { caseSensitive?: boolean; wholeWord?: boolean; wrap?: boolean };
}

type FindReply = {
  ok: boolean;
  matches: number;
  /** 1-based position of the current match, 0 when there is none. */
  ordinal: number;
  /** "css-highlights" when painting, "none" when this engine lacks
      the CSS Custom Highlight API (counts still exact). */
  highlight: "css-highlights" | "none";
  error?: string;
};

const G = window as unknown as Record<string, unknown>;

/* Idempotent guard: the SW attaches the source to every command (it
   cannot know which documents already loaded the finder), and a
   hostile page may clobber the global between commands - the guard
   simply re-arms on the next command. */
if (typeof G.__zlFind !== "function") {
  const HL_ALL = "__zl_find";
  const HL_CUR = "__zl_cur";
  const STYLE_ID = "__zl-find-style";

  /* Feature-detected once; access goes through casts so the build
     never depends on lib-dom covering the Highlight API. */
  const cssHigh = (CSS as unknown as {
    highlights?: { set(k: string, v: unknown): void; delete(k: string): boolean };
  }).highlights;
  const HighlightCtor = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => { priority?: number };
  }).Highlight;
  const canPaint = !!cssHigh && typeof HighlightCtor === "function";

  let ranges: Range[] = [];
  let ord = -1;

  function replyBase(): { matches: number; ordinal: number; highlight: FindReply["highlight"] } {
    return {
      matches: ranges.length,
      ordinal: ord + 1,
      highlight: canPaint ? "css-highlights" : "none",
    };
  }

  function paint(): void {
    const H = HighlightCtor;
    if (!cssHigh || !H) return;
    cssHigh.delete(HL_ALL);
    cssHigh.delete(HL_CUR);
    if (ranges.length) cssHigh.set(HL_ALL, new H(...ranges));
    const cur = ranges[ord];
    if (cur) {
      const h = new H(cur);
      /* Group priority over the all-matches overlay where supported;
         a plain no-op property on engines without it. */
      h.priority = 1;
      cssHigh.set(HL_CUR, h);
    }
  }

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "::highlight(__zl_find){background-color:#ffe17d;color:#000}" +
      "::highlight(__zl_cur){background-color:#ff9632;color:#000}";
    (document.head || document.documentElement).appendChild(s);
  }

  function scrollCurrent(): void {
    const r = ranges[ord];
    if (!r) return;
    try {
      const el = r.startContainer.parentElement;
      (el ?? (document.scrollingElement as Element | null))?.scrollIntoView({ block: "center" });
    } catch { /* detached range: nothing to scroll */ }
  }

  function collectTexts(root: Node, acc: Text[]): void {
    /* 4 = NodeFilter.SHOW_TEXT; skip the non-rendered text holders. */
    const tw = document.createTreeWalker(root, 4, {
      acceptNode(n: Node) {
        const p = (n as Text).parentElement;
        if (p && /^(script|style|noscript|template)$/i.test(p.localName)) return 2;
        return 1;
      },
    });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) acc.push(n as Text);
    /* Open shadow roots are invisible to a main-document walker:
       walk the element tree and recurse into each one. */
    const te = document.createTreeWalker(root, 1, null);
    for (let n = te.nextNode(); n; n = te.nextNode()) {
      const sr = (n as Element).shadowRoot;
      if (sr) collectTexts(sr, acc);
    }
  }

  function find(pattern: string, options: { caseSensitive?: boolean; wholeWord?: boolean }): FindReply {
    /* Re-query semantics (#29): every find re-walks the document, so
       dynamically inserted content is covered by the next query;
       next/prev reuse the current match list. */
    ranges = [];
    ord = -1;
    const re = buildRegex(pattern, options);
    if (re) {
      const acc: Text[] = [];
      collectTexts(document, acc);
      for (const t of acc) {
        for (const p of matchPositions(t.data, re)) {
          const r = document.createRange();
          r.setStart(t, p);
          r.setEnd(t, p + pattern.length);
          ranges.push(r);
        }
      }
    }
    if (ranges.length) {
      ord = 0;
      if (canPaint) ensureStyle();
      paint();
      scrollCurrent();
    } else {
      paint();
    }
    return { ok: true, ...replyBase() };
  }

  function move(dir: 1 | -1, wrap: boolean): FindReply {
    const n = stepOrdinal(ord, ranges.length, dir, wrap);
    if (n >= 0) ord = n;
    if (ranges.length) {
      paint();
      scrollCurrent();
    }
    return { ok: true, ...replyBase() };
  }

  function clear(): FindReply {
    ranges = [];
    ord = -1;
    paint();
    return { ok: true, ...replyBase() };
  }

  G.__zlFind = (ev: MessageEvent): void => {
    const m = ev.data as FindLoadMessage;
    if (!m || m.type !== "zl:findLoad" || typeof m.dest !== "string") return;
    /* Same addressing rule as every page-targeted engine message:
       only the document the client named. */
    const own = ((G.__ZL as { dest?: string } | undefined)?.dest as string | undefined) ?? document.baseURI;
    if (m.dest !== own) return;
    const port = ev.ports && ev.ports[0];
    if (!port) return;
    const fail = (error: string): FindReply => ({ ok: false, matches: 0, ordinal: 0, highlight: canPaint ? "css-highlights" : "none", error });
    let res: FindReply;
    try {
      if (m.cmd === "find") res = find(String(m.pattern ?? ""), m.options ?? {});
      else if (m.cmd === "next") res = move(1, m.options?.wrap !== false);
      else if (m.cmd === "prev") res = move(-1, m.options?.wrap !== false);
      else if (m.cmd === "clear") res = clear();
      else res = fail("bad cmd");
    } catch (err) {
      res = fail(String(err));
    }
    port.postMessage(res);
  };
}
