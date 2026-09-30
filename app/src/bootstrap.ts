/* Zeolite runtime bootstrap. Injected into proxied HTML by the
   rewriter right after opens.

   It only patches behavior: storage scoping, storage/cookie
   virtualization, the shared-worker port relay, WebSocket routing,
   the worker WebSocket relay, the navigator.serviceWorker shim and
   the navigation guard (issue #28). URL-level fetch/XHR need no
   patch: pages navigate within engine-local paths that the service
   worker intercepts natively.

   The source is split into modules under ./bootstrap; the bundler
   merges them into this single synchronous artifact, because the
   patches must exist before the page's own scripts run (lazy
   loading would leave an unpatched window). The CI size gate covers
   the built artifact.

   Budget: under 6.5 KiB minified (CI enforces). Raised from 5 KiB
   for the navigation guard: a deliberate decision, recorded in the
   workflow file, never creep.

   Page-global contract (set by the rewriter at injection time):
   window.__ZL = { dest: "https://real.site/page" }
   falls back to document.baseURI when absent. */

import { fnv1a, pageOrigin } from "./bootstrap/siteid";
import { applyStorage } from "./bootstrap/storage";
import { applyCookie } from "./bootstrap/cookie";
import { applyRelay } from "./bootstrap/relay";
import { applyWs } from "./bootstrap/ws";
import { applyNavGuard } from "./bootstrap/navguard";

const w = window as unknown as Record<string, unknown>;
const ZL = ((w.__ZL as { dest: string } | undefined) ??
  { dest: document.baseURI }) as { dest: string };

/* "" when the destination is unparseable: the storage prefix falls
   back to "unknown" and the cookie / serviceWorker shims stay native. */
const ORIGIN = pageOrigin(ZL.dest);
const P = "zl:" + fnv1a(ORIGIN || "unknown") + ":";

applyStorage(w, P);
applyCookie(ORIGIN);
applyRelay(w, ORIGIN, ZL.dest);
applyWs(w, ORIGIN);
applyNavGuard(w, (w.location as Location).href, (w.location as Location).origin);
