/* Page-init script builder (issue #32).

   The rewriter used to inject the page's real destination as
   window.__ZL = { dest: "https://real.site/page" } so the bootstrap
   could derive its per-site identity (storage prefix, cookie / ws /
   relay shims). That global was a direct leak of the target to any
   page script (#32's leak 1).

   The bootstrap does not need the URL: every consumer only needs a
   stable per-site identity, and the service worker can compute the
   same identity itself, from the destination it already holds
   privately. With a #55 route key active the token is a SipHash MAC
   of the target origin under that SW-realm key (keyedSiteToken):
   stable per site and not reversible by an origin dictionary. The
   keyless degraded mode keeps the fnv1a(origin) token, the exact
   value bootstrap storage scoping used to derive page-side. The
   injected contract becomes window.__ZL = { site: "<token>" }: an
   opaque, per-site stable id. Same site across reloads -> same
   storage; two sites -> different tokens; the real URL never enters
   the page realm.

   Pure code so the leak property is unit-tested: initScript() output
   must not contain the destination or any straightforward encoding
   of it. */

import { keyedSiteToken } from "./codec";
import { fnv1a, pageOrigin } from "./bootstrap/siteid";

/** Opaque per-site identity: the keyed MAC of the target origin when
    a #55 route key is active, the fnv1a hash otherwise. */
export function siteToken(dest: string): string {
  const origin = pageOrigin(dest) || "unknown";
  return keyedSiteToken(origin) ?? fnv1a(origin);
}

/** The inline init script spliced into the rewritten stream head
    AFTER the doctype (quirks fix; it used to ride the very first
    chunk, before the doctype, which forced quirks mode on every
    proxied document). An active fingerprint profile rides the same
    splice (1.8). */
export function initScript(dest: string, fpScript: string | null): string {
  return (
    `<script>window.__ZL=${JSON.stringify({ site: siteToken(dest) })};</script>` +
    (fpScript ? `<script>${fpScript}</script>` : "")
  );
}

/** Where initScript splices into the stream head (quirks fix): AFTER
    the doctype's closing ">" when the document opens with one, else
    at index 0. A script start tag seen before the doctype puts the
    parser in quirks mode and the real doctype is then ignored as a
    parse error, so the hunt may only skip leading BOM, whitespace
    and comments. Returns null while the head is too short to decide
    (a doctype split across stream chunks); eos=true (end of stream)
    forces a decision. Index 0 for doctype-less documents keeps them
    in quirks mode instead of accidentally upgrading them.
    ponytail: a ">" inside a legacy doctype's internal subset would
    end the hunt early; pre-HTML5 archaeology, upgrade to a real
    tokenizer only if a page ever needs it. */
export function initSplicePoint(head: string, eos = false): number | null {
  let i = head.startsWith("\uFEFF") ? 1 : 0;
  for (;;) {
    while (i < head.length && /\s/.test(head[i])) i++;
    if (head.startsWith("<!--", i)) {
      const end = head.indexOf("-->", i + 4);
      if (end === -1) return eos ? 0 : null;
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(head.slice(i))) {
      const gt = head.indexOf(">", i);
      if (gt === -1) return eos ? 0 : null;
      return gt + 1;
    }
    /* A "<" that could still grow into "<!doctype" is undecided
       (wait for more stream); anything else - an element, text -
       means no usable doctype can follow: index 0. */
    const m = /^<![a-z]*/i.exec(head.slice(i));
    if (m && "<!doctype".startsWith(m[0].toLowerCase())) return eos ? 0 : null;
    if (i >= head.length) return eos ? 0 : null;
    return 0;
  }
}
