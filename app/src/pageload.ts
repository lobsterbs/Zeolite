/* Page-init script builder (issue #32).

   The rewriter used to inject the page's real destination as
   window.__ZL = { dest: "https://real.site/page" } so the bootstrap
   could derive its per-site identity (storage prefix, cookie / ws /
   relay shims). That global was a direct leak of the target to any
   page script (#32's leak 1).

   The bootstrap does not need the URL: every consumer only needs a
   stable per-site identity, and the service worker can compute the
   same identity itself, from the destination it already holds
   privately: siteToken = fnv1a(target origin || "unknown"), the exact
   value bootstrap storage scoping used to derive page-side. The
   injected contract becomes window.__ZL = { site: "<token>" }: an
   opaque, non-reversible, per-site stable id. Same site across
   reloads -> same storage; two sites -> different tokens; the real
   URL never enters the page realm.

   Pure code so the leak property is unit-tested: initScript() output
   must not contain the destination or any straightforward encoding
   of it. */

import { fnv1a, pageOrigin } from "./bootstrap/siteid";

/** Opaque per-site identity: the hash of the target origin, the same
    value the bootstrap's storage scoping derives. */
export function siteToken(dest: string): string {
  return fnv1a(pageOrigin(dest) || "unknown");
}

/** The inline init script injected before the first rewritten chunk.
    An active fingerprint profile rides the same first chunk (1.8). */
export function initScript(dest: string, fpScript: string | null): string {
  return (
    `<script>window.__ZL=${JSON.stringify({ site: siteToken(dest) })};</script>` +
    (fpScript ? `<script>${fpScript}</script>` : "")
  );
}
