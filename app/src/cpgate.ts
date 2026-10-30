/* Control-plane sender gate (#41/#48), extracted from sw.ts for #63.
   sw.ts cannot be imported by vitest (its module body registers the
   service worker), so the pure half of the gate lives here: which
   client URLs count as proxied-page senders and which message types
   a proxied page may send. #63 acceptance pins that zl:navHandle is
   host-only: it must never join PAGE_MESSAGES - a proxied page must
   not be able to mint initial-navigation handles for arbitrary
   destinations. */

import { isEnginePath, NAVH, queryHandleToken } from "./codec";
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
  /* #180 (Injector phase 1): the anchor read shim's decode oracle.
     Admitted like zl:mint: the destinations are the page's own
     markup data, a keyed decode needs the realm key the page never
     holds, and garbage or foreign tokens decode to null. Bounded
     worker-side; no new capability. */
  "zl:decodeRoutes",
  /* #477 wave 3: the swshim register/unregister forward. The
     page registration reaches the guest kernel with pageUrl
     recovered worker-side from the sender route (never
     page-supplied), so a proxied page can only spawn a guest for
     its OWN origin and script/scope pair; unregister names no
     target at all - the worker terminates the sender origin. */
  "zl:guestRegister",
  "zl:guestUnregister",
  /* #456 gate 4: the page-side own-404 watcher report (injected by
     the init script). Names no target and carries no data; the
     handler recovers the sender's own origin from its route (never
     a page claim), so a report can only corroborate the sender's
     OWN origin into the bounded, fail-open hybrid location pass.
     No new capability. */
  "zl:spa404",
]);

/** Pathname half of the sender classification: true when a client at
    this pathname is a proxied page (an engine route, a NAVH handle
    (#144), a navguard marker, or extension code), not a host page.
    #48: /zl-ext/ and /zl-cs/ host extension code, never host pages.
    #151: a handle-navigated page is a proxied page; without the NAVH
    arm it classified as a host page and every host-only control
    message was accepted from it. */
export function senderIsProxiedPath(pathname: string, search?: string): boolean {
  return (
    isEnginePath(pathname) ||
    pathname.startsWith(NAVH) ||
    pathname.startsWith(NAV) ||
    pathname.startsWith(EXT_ROUTE) ||
    pathname.startsWith(CS_ROUTE) ||
    /* Injector phase 2: a query-shape committed URL is a proxied page
       at ANY pathname; the zlNavh param is the engine's mark (an
       impostor value fails closed worker-side). Presence-only here:
       the gate is cheap and runs before any key material is needed. */
    (search !== undefined && queryHandleToken(search) !== null)
  );
}


/* #170: the HOST-page half of the gate. The old classifier trusted
   anything that was not an engine path, so an about:blank, blob: or
   unknown-route client passed as a host page; the gate must fail
   closed onto a small allowlist of the engine's own pages instead:
   the adapter (LB's single-page UI lives at "/"), its index, and
   the devtools page. Everything else - unparseable, cross-origin,
   opaque or unknown - is treated as untrusted. */
const HOST_PATHS = new Set([
  "/",
  "/index.html",
  "/devtools.html",
  /* #107 phase 2: the LB split-origin design embeds its /zlsw-register
     boot page on the content origin so proxied frames render
     cross-origin to the app. The boot page owns the content-origin
     relay and wisp registration plus the embedder handshake - all
     host-only control traffic; without this entry the fail-closed
     gate classifies it as a proxied sender and silently refuses
     every registration. Grants no new capability: "/" is already a
     host path, so a page can already drive its own SW as host. */
  "/zlsw-register",
  /* #477 wave 3: the guest-host page spawns guest realms on the
     engine origin (LB embeds it hidden). Its own traffic is
     host-only (zl:guestHost port); the page runs no guest code. */
  "/guest-host.html",
]);

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
  /* Injector phase 2: a query-shape committed URL is a proxied page
     even at a host pathname ("/" or "/index.html"): the engine never
     mints a zlNavh token for a host page, so the param's presence
     fails closed - the sender keeps the proxied refusal, never host
     powers. */
  if (queryHandleToken(u.search) !== null) return false;
  return HOST_PATHS.has(u.pathname);
}
