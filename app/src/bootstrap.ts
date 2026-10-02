/* Zeolite runtime bootstrap. Injected into proxied HTML by the
   rewriter right after opens.

   It only patches behavior: storage scoping, storage/cookie
   virtualization, the shared-worker port relay, WebSocket routing,
   the worker WebSocket relay, the navigator.serviceWorker shim and
   the navigation guard (issue #28) and the on-demand find loader
   (issue #29). #37 adds the cross-site channel isolation: storage
   events, BroadcastChannel names, window.name scoping, and honest
   cookieStore removal. URL-level fetch/XHR need no
   patch: pages navigate within engine-local paths that the service
   worker intercepts natively.

   The source is split into modules under ./bootstrap; the bundler
   merges them into this single synchronous artifact, because the
   patches must exist before the page's own scripts run (lazy
   loading would leave an unpatched window). The CI size gate covers
   the built artifact.

   Budget: under 12 KiB minified (CI enforces). 5 KiB originally,
   6.5 for the #28 navigation guard, 8 when the artifact became the
   single classic file the browser run demanded (issue #35): what
   used to ride in shared chunks (the nav guard, the codec helpers)
   now bundles into the one file the page loads. 10 for #37: the
   cross-site channel isolation (storage events, BroadcastChannel,
   window.name, cookieStore removal) is per-page correctness, not
   optional payload. 11 for the #28 parser-inserted iframe observer
   (a frame injected by innerHTML or document.write has no bootstrap
   of its own, so the document rewrites its src before the browser's
   queued load task). 12 for the #58 srcdoc pass (a srcdoc child
   document gets no bootstrap either, so the parent rewrites its
   markup) and the #59 setAttribute robustness rows. Deliberate
   raises, recorded in the workflow file, never creep.

   Page-global contract (set by the rewriter at injection time,
   issue #32): window.__ZL = { site: "<opaque token>" } - a stable
   per-site identity the engine computes from the real destination,
   which itself never reaches the page. Absent (an unrewritten
   document): the identity falls back to hashing document.baseURI,
   so storage stays scoped and every shim stays native. */

import { fnv1a, pageOrigin } from "./bootstrap/siteid";
import { applyStorage } from "./bootstrap/storage";
import { applyIsolation } from "./bootstrap/isolation";
import { applyCookie } from "./bootstrap/cookie";
import { applyRelay } from "./bootstrap/relay";
import { applyWs } from "./bootstrap/ws";
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
applyIsolation(w, P, st);
applyNavGuard(w, loc.href, loc.origin);
applyFindLoad(w);
