/* Control-plane sender gate (#41/#48), extracted from sw.ts for #63.
   sw.ts cannot be imported by vitest (its module body registers the
   service worker), so the pure half of the gate lives here: which
   client URLs count as proxied-page senders and which message types
   a proxied page may send. #63 acceptance pins that zl:navHandle is
   host-only: it must never join PAGE_MESSAGES - a proxied page must
   not be able to mint initial-navigation handles for arbitrary
   destinations. */

import { isEnginePath } from "./codec";
import { NAV } from "./bootstrap/navguard";
/* The constants come from serve, not the barrel: serve's module graph
   is proven vitest-import-safe (ext-pages.test.ts), the barrel pulls
   the whole runtime surface for two string constants. */
import { CS_ROUTE, EXT_ROUTE } from "./extensions/serve";

/** Page-facing control messages: sent from inside proxied documents
    and their workers (the bootstrap's docCookie/WS channels and the
    content-script bridge), plus zl:ping (its echo carries no secrets
    and page code may probe liveness) and zl:mint (the #54 residual 1
    seam: a page can already construct a legacy route for any
    destination itself, so minting grants no new capability). */
export const PAGE_MESSAGES: ReadonlySet<string> = new Set([
  "zl:mint",
  "zl:docCookie",
  "zl:wsOpen",
  "zl:ext",
  "zl:ping",
]);

/** Pathname half of the sender classification: true when a client at
    this pathname is a proxied page (an engine route, a navguard
    marker, or extension code), not a host page. #48: /zl-ext/ and
    /zl-cs/ host extension code, never host pages. */
export function senderIsProxiedPath(pathname: string): boolean {
  return (
    isEnginePath(pathname) ||
    pathname.startsWith(NAV) ||
    pathname.startsWith(EXT_ROUTE) ||
    pathname.startsWith(CS_ROUTE)
  );
}
