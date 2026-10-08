/* Zeolite runtime bootstrap, injected by the rewriter right after
   <head> opens. Behavior patches only: storage scoping/virtualization,
   cookies, the worker port relay, WebSocket routing, the serviceWorker
   shim, the navigation guard (#28), the find loader (#29) and the
   cross-site channel isolation (#37). URL-level fetch/XHR need no
   patch: pages navigate engine-local paths the SW intercepts.

   Source modules under ./bootstrap bundle into one synchronous
   artifact (patches must exist before page scripts run); the CI size
   gate covers the built artifact. Budget: under 20 KiB minified.

   Budget history (raises recorded in the workflow file): 5 KiB
   original, 6.5 for the #28 nav guard, 8 for the single-file
   artifact (#35), 10 for #37 channel isolation, 11 for the #28
   parser-inserted iframe observer, 12 for the #58 srcdoc pass and
   #59 setAttribute rows, 16 for #54 (page-realm mint client,
   re-emission, navguard swap/defer seams), 18 for the #54
   dedicated-Worker hook, 19 for #106/#108 (popup activation guard,
   child-realm isolation), 20 for #109 (popup sync-open, relative
   navigation-bound re-emit). Deliberate raises, never creep.

   Page-global contract (#32): window.__ZL = { site: "<opaque>" } -
   a per-site identity computed from the real destination, which
   never reaches the page. Absent, the identity falls back to
   hashing document.baseURI. */

import { fnv1a, pageOrigin } from "./bootstrap/siteid";
import { applyStorage } from "./bootstrap/storage";
import { applyIsolation } from "./bootstrap/isolation";
import { applyCookie } from "./bootstrap/cookie";
import { applyRelay } from "./bootstrap/relay";
import { applyWs } from "./bootstrap/ws";
import { applyReemit } from "./bootstrap/mint";
import { applyNavGuard } from "./bootstrap/navguard";
import { applyFindLoad } from "./bootstrap/findload";

const w = window as unknown as Record<string, unknown>;
const loc = w.location as Location;
const ZL = (w.__ZL as { site?: string } | undefined) ?? {};
const site = ZL.site || fnv1a(pageOrigin(document.baseURI) || "unknown");

/* "zl:" + opaque per-site token + ":": same scoping as before #32,
   now derived from the engine-computed token instead of a page-held
   real origin. */
const P = "zl:" + site + ":";

const st = applyStorage(w, P);
applyCookie(site);
applyRelay(w, site, loc.href);
applyWs(w);
applyReemit(w);
applyIsolation(w, P, st);
applyNavGuard(w, loc.href, loc.origin, site);
applyFindLoad(w);
