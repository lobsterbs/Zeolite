/* Control-plane sender gate (#41/#48), extracted from sw.ts for #63.
   sw.ts cannot be imported by vitest (its module body registers the
   service worker), so the pure half of the gate lives here: which
   client URLs count as proxied-page senders and which message types
   a proxied page may send. #63 acceptance pins that zl:navHandle is
   host-only: it must never join PAGE_MESSAGES - a proxied page must
   not be able to mint initial-navigation handles for arbitrary
   destinations. */

import { isEnginePath, NAVH } from "./codec";
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
  /* #130: the page's OWN virtual origin, recovered worker-side from
     the sender's route; a page-supplied claim is never read, so this
     grants no cross-site capability. */
  "zl:getVirtualOrigin",
  /* #107 phase 2: the embedder handshake an embedded frame needs
     for URL/title sync. Names only the sender's own decoded state
     and the public embedder origin; grants no cross-site reach. */
  "zl:getEmbedder",
]);

/** Pathname half of the sender classification: true when a client at
    this pathname is a proxied page (an engine route, a NAVH handle
    (#144), a navguard marker, or extension code), not a host page.
    #48: /zl-ext/ and /zl-cs/ host extension code, never host pages.
    #151: a handle-navigated page is a proxied page; without the NAVH
    arm it classified as a host page and every host-only control
    message was accepted from it. */
export function senderIsProxiedPath(pathname: string): boolean {
  return (
    isEnginePath(pathname) ||
    pathname.startsWith(NAVH) ||
    pathname.startsWith(NAV) ||
    pathname.startsWith(EXT_ROUTE) ||
    pathname.startsWith(CS_ROUTE)
  );
}


/* #170: the HOST-page half of the gate. The old classifier trusted
   anything that was not an engine path, so an about:blank, blob: or
   unknown-route client passed as a host page; the gate must fail
   closed onto a small allowlist of the engine's own pages instead:
   the adapter (LB's single-page UI lives at "/"), its index, and
   the devtools page. Everything else - unparseable, cross-origin,
   opaque or unknown - is treated as untrusted. */
const HOST_PATHS = new Set(["/", "/index.html", "/devtools.html"]);

/** True only when the sender is one of the engine's own host pages:
    the URL must parse against this origin, be same-origin, and name
    a known host path. #170: control.ts's senderIsProxiedPage inverts
    this so host-only control messages fail closed. */
export function senderIsHostPage(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  return HOST_PATHS.has(u.pathname);
}
