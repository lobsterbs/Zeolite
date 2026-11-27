/* Per-client virtual context routing (issue #33).

   A proxied page's relative request arrives as an engine-origin
   request with no destination inside. The old recovery,
   referrerDest(), trusts a header the page and browser both
   influence (no-referrer strips it; missing referrer fell to the
   embedder origin). The fetch event carries a stronger identity:
   clientId / resultingClientId. The worker maps client ids to a
   small VirtualContext, established when the client's document or
   worker script is served from a decodable engine route, and
   resolves escaped same-origin paths against it first. Referrer
   decoding survives only as a compatibility fallback.

   Scope choices, honestly:
   - The map is memory-only; a restarted SW re-establishes per
     client from the first decodable request. Client ids die
     with their worker - nothing worth persisting.
   - "Establish or update" replaces the entry whole on the next
     navigation that creates the client (one Map.set, no request
     sees a half-replaced context). Subresource routes never
     touch the entry (currentUrl is the document's address).
   - The issue's profileId/cookieJarId/storageNamespace/
     routePrefix fields are deliberately absent: that state lives
     in cookies.ts/rules.ts/codec.ts and duplication would fork
     the truth.
   - Worker contexts use the worker's own client id from its
     script route, never a page referrer (rule 5).

   Pure code: the map is a parameter, so restart, replacement,
   isolation and missing-referrer behavior are all unit-tested. */

import { isEngineAsset } from "./codec";

export interface VirtualContext {
  /** Map key: the SW-assigned client id. */
  id: string;
  /** Same value as id; kept for the issue #33 shape. */
  clientId: string;
  /** Upstream origin of the establishing document or worker script. */
  targetOrigin: string;
  /** The full upstream URL that established the context (with query). */
  currentUrl: string;
  /** #596: client shape for the guest clients facade - "window" for
      document navigations, "worker"/"sharedworker" for worker-script
      destinations. Absent means the pre-#596 window default. */
  clientKind?: "window" | "worker" | "sharedworker";
  /** #611: the client is a browsing pane's main surface (its document
      was served from a minted navigation handle), so its own
      navigations are top-level for Sec-Fetch purposes. Absent or
      false means subframe semantics (fail closed). */
  mainSurface?: boolean;
}

/** Default cap for the context map. Client ids are never reused, so a
    stale entry is only memory, never a wrong routing decision; past
    this many live proxied clients the oldest contexts drop and those
    clients (if somehow still alive) fall back to the referrer path. */
export const VCTX_CAP = 256;

/** Install (or atomically replace) a client's context. The entry is
    constructed whole, then written with one Map.set. Returns null and
    writes nothing for unparseable or non-http(s) targets: a context is
    never established for an origin the engine would not proxy. */
export function establishContext(
  map: Map<string, VirtualContext>,
  clientId: string,
  target: string,
  kind: "window" | "worker" | "sharedworker" = "window",
  mainSurface = false,
): VirtualContext | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const ctx: VirtualContext = {
    id: clientId,
    clientId,
    targetOrigin: u.origin,
    currentUrl: target,
    clientKind: kind,
    /* #611: stored only when true, so an absent field always means
       subframe semantics for any reader. */
    ...(mainSurface ? { mainSurface: true } : {}),
  };
  map.set(clientId, ctx);
  return ctx;
}

/** The requesting client's context, if the worker knows one. */
export function contextOf(
  map: Map<string, VirtualContext>,
  clientId: string | undefined,
): VirtualContext | undefined {
  return clientId ? map.get(clientId) : undefined;
}

/** Resolve an escaped same-origin path against the client's context.
    Directory-relative tails ("img/x.png") resolve against the
    establishing document's full URL (its directory); absolute paths
    (leading "/") resolve to the origin root, unchanged. Null when no
    context exists (the caller falls back to referrer decoding, then
    passthrough) or when the path does not parse against it. */
export function resolveRelative(
  map: Map<string, VirtualContext>,
  clientId: string | undefined,
  path: string,
): string | null {
  const ctx = contextOf(map, clientId);
  if (!ctx) return null;
  try {
    return new URL(path, ctx.currentUrl).href;
  } catch {
    return null;
  }
}

/** Last-resort home for a same-origin path issued by a realm the worker
    cannot key to a context: a blob: challenge iframe/worker spawned by a
    proxied page has no decodable client URL (establishFromClientUrl
    installs nothing for opaque URLs) and its referrer is opaque too, so
    its root-relative site paths (Cloudflare's /cdn-cgi/ challenge scripts
    are the live case) would otherwise strand at the #101 passthrough and
    the origin server's content-typeless 404 MIME-blocks the script.

    #687 fail-closed: the home is only returned when it is UNAMBIGUOUS.
    Every live window context must sit on the SAME upstream origin, so
    whichever one is picked the resolved dest is identical (the usual
    single-proxied-tab Turnstile boot). With window contexts on two or
    more DIFFERENT origins (two proxied tabs on different sites) the
    realm cannot be tied to any one of them - a blob: client's URL is
    opaque and its referrer does not decode, and any decodable client
    URL or referrer was already consumed by the context/referrer
    recovery upstream - so this returns undefined and the caller keeps
    the honest passthrough: a context-less realm must never be routed to
    a different virtual site (that leaked the other site's jar cookies
    upstream, #687). Worker contexts are skipped as before. Pure, total. */
export function unambiguousWindowContext(
  map: Map<string, VirtualContext>,
): VirtualContext | undefined {
  let last: VirtualContext | undefined;
  let origin: string | undefined;
  for (const c of map.values()) {
    if (c.clientKind === "worker" || c.clientKind === "sharedworker") continue;
    if (last !== undefined && c.targetOrigin !== origin) return undefined;
    last = c;
    origin = c.targetOrigin;
  }
  return last;
}

/** Keep the context map bounded: past max entries the oldest
    (insertion-order) contexts drop. Pure, total, never throws. */
export function capContexts(map: Map<string, VirtualContext>, max: number): void {
  if (max <= 0 || map.size <= max) return;
  for (const id of map.keys()) {
    if (map.size <= max) break;
    map.delete(id);
  }
}

/** #535: a service-worker restart wipes this map while every proxied
    page it served stays open, and their next same-origin relative
    request arrives with a client id the fresh worker has never seen.
    The browser-committed client URL is the one recovery source the
    worker can trust: decode it with the engine's own route decoder (a
    parameter, keeping this module pure) and install the context whole.
    Any URL the decoder rejects (a blob: worker client, the landing
    page, a pushed non-route path) installs nothing: fail-closed, the
    caller keeps the honest error. */
export function establishFromClientUrl(
  map: Map<string, VirtualContext>,
  clientId: string,
  clientUrl: string,
  decode: (u: URL) => string | null,
  mainSurface = false,
): VirtualContext | null {
  let u: URL;
  try {
    u = new URL(clientUrl);
  } catch {
    return null;
  }
  const target = decode(u);
  if (!target) return null;
  /* #611: surface class flows through the client-URL rehydration so
     a restarted worker restores it from the same shape oracle. */
  return establishContext(map, clientId, target, "window", mainSurface);
}
/** #708 (run 8): a context-less same-origin SUBFRAME navigation - a
    parser- or script-created iframe whose src no rewriter arm minted
    (Google botguard /_/bscframe on the committed query-handle
    sign-in page) - arrives with neither a bearing clientId nor a
    referrer any codec arm decodes, so the #101 escape answered it
    with the origin SPA catch-all and the host shell rendered inside
    the botguard frame. The page that created the frame is still
    live in this worker: its window context is the only honest home
    left, under the same #687 unambiguity rule the cdn-cgi arm
    uses - every live window context on ONE upstream origin, else
    the frame cannot be attributed and the request keeps the
    honest escape.

    Narrower than the #101 cdn-cgi arm on purpose:
    - GET iframe navigations only. A top-level document navigation
      to a bare path may be an address-bar load of the host app and
      must keep the passthrough (the #511 location-write class
      already recovers through its own client context).
    - the host-owned origin-root surfaces (the boot page guest-host
      iframe, the engine asset vocabulary) answer from the origin
      server, never from the proxied site.
    Pure, total, map-parameterized like the rest of this module. */
export function navRealmDest(
  map: Map<string, VirtualContext>,
  method: string,
  mode: string,
  destination: string,
  pathname: string,
  search: string,
): string | null {
  if (method !== "GET") return null;
  if (mode !== "navigate") return null;
  if (destination !== "iframe") return null;
  if (isEngineAsset(pathname) || pathname === "/guest-host.html") return null;
  const ctx = unambiguousWindowContext(map);
  if (!ctx || !ctx.currentUrl) return null;
  try {
    const dest = new URL(pathname + search, ctx.currentUrl).href;
    if (!/^https?:$/.test(new URL(dest).protocol)) return null;
    return dest;
  } catch {
    return null;
  }
}

