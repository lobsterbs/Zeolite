/* Per-client virtual context routing (issue #33).

   Proxied pages live on the engine origin, so a page's own relative
   request ("fetch('/api/data')") arrives at the service worker as an
   engine-origin request with no destination inside it. The old
   recovery was referrerDest(): decode the request referrer (an
   engine route) and resolve the path against the serving page's
   upstream origin. That trusts a header the page and the browser
   both influence: Referrer-Policy: no-referrer strips it entirely,
   and any request that arrives without a referrer routed to the
   embedder origin instead.

   The fetch event already carries a stronger identity: clientId for
   controlled requests, resultingClientId for requests that create a
   client (document navigations, worker script loads). The worker
   owns a map from client id to a small VirtualContext, established
   when the client's own document or worker script is served from a
   decodable engine route, and resolves escaped same-origin paths
   against the requesting client's context first. Referrer decoding
   survives only as a compatibility fallback (no context:
   subresources of a page that predates a SW restart, or a client id
   the SW never saw).

   Scope choices, honestly:
   - The map is memory-only. A restarted SW starts empty and
     re-establishes per client from the first decodable request; until
     then the referrer fallback carries those pages. Contexts carry
     no state worth persisting: client ids die with their worker.
   - "Establish or update" (routing rule 1) means replacement on the
     next navigation that creates the client: the entry is built
     whole and installed with a single Map.set, so no request can
     observe a half-replaced context (rule 6). Subresource routes do
     NOT touch the entry: currentUrl is the document's address, not
     the address of the last fetched sprite.
   - The issue's suggested profileId / cookieJarId /
     storageNamespace / routePrefix fields are deliberately absent:
     jar profiles and rule sets are engine-global state (cookies.ts,
     rules.ts), the route prefix and scheme live in codec.ts, and
     duplicating them here would fork the truth. The shape stays
     minimal and real.
   - Worker contexts are established under the worker's own client id
     from its script route, so worker requests inherit an explicit
     context, never a page referrer (rule 5). The prelude already
     routes most worker fetches into engine routes; the context
     covers the rest.

   Pure code: the map is a parameter, so restart (a fresh map),
   client replacement, isolation and missing-referrer behavior are
   all unit-tested without a live worker. */

export interface VirtualContext {
  /** Map key: the SW-assigned client id. */
  id: string;
  /** Same value as id; kept for the issue #33 shape. */
  clientId: string;
  /** Upstream origin of the establishing document or worker script. */
  targetOrigin: string;
  /** The full upstream URL that established the context (with query). */
  currentUrl: string;
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

/** Resolve an escaped same-origin path against the client's upstream
    origin. Null when no context exists (the caller falls back to
    referrer decoding, then passthrough) or when the path does not
    parse against it. */
export function resolveRelative(
  map: Map<string, VirtualContext>,
  clientId: string | undefined,
  path: string,
): string | null {
  const ctx = contextOf(map, clientId);
  if (!ctx) return null;
  try {
    return new URL(path, ctx.targetOrigin).href;
  } catch {
    return null;
  }
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
