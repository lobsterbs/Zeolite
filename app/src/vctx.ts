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

/** Keep the context map bounded: past max entries the oldest
    (insertion-order) contexts drop. Pure, total, never throws. */
export function capContexts(map: Map<string, VirtualContext>, max: number): void {
  if (max <= 0 || map.size <= max) return;
  for (const id of map.keys()) {
    if (map.size <= max) break;
    map.delete(id);
  }
}
