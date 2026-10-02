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

/** The inline init script injected before the first rewritten chunk.
    An active fingerprint profile rides the same first chunk (1.8). */
export function initScript(dest: string, fpScript: string | null): string {
  return (
    `<script>window.__ZL=${JSON.stringify({ site: siteToken(dest) })};</script>` +
    (fpScript ? `<script>${fpScript}</script>` : "")
  );
}
