/* Zeolite runtime bootstrap, injected by the rewriter right after
   <head> opens. Behavior patches only: storage scoping/virtualization,
   cookies, the worker port relay, WebSocket routing, the serviceWorker
   shim, the navigation guard (#28), the find loader (#29), the
   postMessage sender repair (#128/#130/#131/#132), the virtual-origin
   marker + message-event filter (#130), the cross-site channel
   isolation (#37), the embedder URL/title sync (#107 phase 2), the
   anchor read virtualization (#180 Injector phase 1), the URL parse
   seam (#510: data-island route literals parse to the decoded
   destination).
   URL-level fetch/XHR need no patch: pages navigate
   engine-local paths the SW intercepts.

   Source modules under ./bootstrap bundle into one synchronous
   artifact (patches must exist before page scripts run); the CI size
   gate covers the built artifact. Budget: under 40704 bytes minified
   (raises: 25600 -> 27648 #236 virtual location, -> 30400 the
   engine-adapter wave, -> 31744 #107 phase 2 embedder sync, -> 33792 #180 anchor read
   virtualization, -> 39680 #477 wave 3, -> 40704 #510 URL parse seam).

   Budget raises (each decided with the feature, never creep): 5 KiB
   original; 6.5 #28 nav guard; 8 #35 single file; 10 #37 isolation;
   11 #28 iframe observer; 12 #58/#59 srcdoc + setAttribute; 16 #54
   page-realm mint client; 18 #54 worker hook; 19 #106/#108 child
   isolation + popup guard; 20 #109 popup sync-open; 21 #121
   engineUpdate notice; 22.5 #128/#129 postMessage repair; 23 #130
   vorigin marker + filter; 24 #132 contentWindow sender half +
   virtual-origin parity drop; 26.5 #236 virtual location.

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
import { applyReemit, routeAnchor } from "./bootstrap/mint";
import { applyNavGuard } from "./bootstrap/navguard";
import { applyFindLoad } from "./bootstrap/findload";
import { applyUpdateNotice } from "./bootstrap/update";
import { applyPostMessage } from "./bootstrap/postmsg";
import { applyVirtualOrigin } from "./bootstrap/vorigin";
import { applyVloc } from "./bootstrap/vloc";
import { applyEmbedSync } from "./bootstrap/embedsync";
import { applyAnchorShim, applyUrlShim } from "./bootstrap/anchorshim";
import { applyDomInspect } from "./bootstrap/dominspect";

const w = window as unknown as Record<string, unknown>;
const loc = w.location as Location;
const ZL = (w.__ZL as { site?: string; vpath?: string } | undefined) ?? {};
const site = ZL.site || fnv1a(pageOrigin(document.baseURI) || "unknown");

/* "zl:" + opaque per-site token + ":": same scoping as before #32,
   now derived from the engine-computed token instead of a page-held
   real origin. */
const P = "zl:" + site + ":";

const st = applyStorage(w, P);
applyCookie(site);
applyRelay(w, site, loc.href);
applyWs(w);
/* #157: anchor the re-emit patch to the page's own engine route, so
   root-relative fetch/XHR/beacon inputs re-emit through the parent
   marker instead of escaping to the proxy origin root. */
applyReemit(w, routeAnchor(loc.href));
applyIsolation(w, P, st);
applyNavGuard(w, loc.href, loc.origin, site);
/* #180: virtualize parser-inserted anchor reads (the property
   getter and getAttribute) once the guard keeps page-written reads
   page-truthful; the install order matters because the shim's
   getter seam is called from inside the guard. */
applyAnchorShim(w);
/* #510: the URL parse seam - a page parsing an engine-minted route
   string (a hydration data island literal) reads the decoded
   virtual destination, the anchorshim race on a miss; engine
   internals keep the captured NativeURL. */
applyUrlShim(w);
applyFindLoad(w);
/* #121: notice (console note + window CustomEvent, never a
   reload) when the worker broadcasts zl:engineUpdate; a stale page
   keeps its old rewritten DOM until the user reloads it. */
applyUpdateNotice(w);
/* #128: same-site frame messaging repair (virtual targetOrigin). */
applyPostMessage(w);
/* #130: virtual-origin marker + message-event origin filter. */
applyVirtualOrigin(w);
/* #236: the virtual location the #235 renames read; pathname-
   routed SPAs see their real path without a document reload. */
applyVloc(w, ZL.vpath);
/* #107 phase 2: URL/title sync up to a registered embedder (split
   origin); inert without one. */
applyEmbedSync(w);
/* #550 Tier 2 DOM inspection bridge (first slice): inert until the
   host authorizes an inspection session for this client; answers the
   SW-relayed requests with serialized data only. */
applyDomInspect(w);
