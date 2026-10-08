/* Cross-origin request policy (issue #34).

   A controlled page's subresource requests all reach the fetch
   handler whatever origin they name - only navigations are
   scope-bound. Before #34 the handler declined foreign-origin
   http(s) requests, so runtime-built or parser/CSS-inserted URLs
   (fetch/XHR, EventSource, sendBeacon, media, workers) escaped
   the engine and exposed the client IP.

   Classification before the SW answers:
   - passthrough: the client is not a proxied document (the
     embedder's own pages) - its traffic keeps the direct path
     with #30 escape telemetry. Failing closed to passthrough
     for unknown clients is the safe direction.
   - preflight: a CORS preflight from a proxied document. The
     target's CORS policy never applied to engine-routed
     responses, so the engine answers the preflight for exactly
     what the page asked; the actual request routes normally.
   - route: a proxied document's request. The full URL is the
     destination; the existing pipeline (SSRF, headers, jar,
     transport, rewriter, netLog) serves it.

   Pure code (unit-tested decision table); the SW owns the async
   client lookup. */

import { decodePath, isOpaqueUrl } from "./codec";

export type ForeignPolicy = "passthrough" | "preflight" | "route";

/** Classify one foreign-origin http(s) request from a controlled
    client. See the module header for the policy. */
export function classifyForeign(input: {
  /** The request URL (foreign http(s)). */
  requestUrl: string;
  /** The SW's own origin. */
  engineOrigin: string;
  /** Request method. */
  method: string;
  /** access-control-request-method present (a CORS preflight). */
  preflight: boolean;
  /** The requesting client's own URL, when the SW could resolve it. */
  clientUrl?: string;
  /** The client has a #33 virtual context: a proxied page or a worker
      the engine itself served (its script URL may be a foreign or
      blob URL, so the URL alone is not the whole truth). */
  hasContext?: boolean;
}): ForeignPolicy {
  let u: URL;
  try {
    u = new URL(input.requestUrl);
  } catch {
    return "passthrough"; // unparseable: never engine work
  }
  /* The caller filters these first; keep the classifier total and
     safe anyway. */
  if (isOpaqueUrl(u) || u.origin === input.engineOrigin) return "passthrough";
  if (!input.clientUrl && !input.hasContext) return "passthrough"; // unknown client: host traffic
  let proxied = !!input.hasContext;
  if (!proxied && input.clientUrl) {
    try {
      proxied = decodePath(new URL(input.clientUrl, input.engineOrigin).pathname) !== null;
    } catch {
      /* client URL unparseable against the engine origin */
    }
  }
  if (!proxied) return "passthrough"; // host-app page: its traffic is its own
  if (input.preflight && input.method === "OPTIONS") return "preflight";
  return "route";
}

/** Synthesize the CORS preflight response headers for a proxied
    document's preflight: granted for exactly the method and headers
    the page asked for, credentials honored. No upstream call is made -
    the actual request routes through the pipeline afterwards. */
export function preflightHeaders(input: {
  /** access-control-request-method (the method the page wants). */
  requestMethod: string | null;
  /** access-control-request-headers (the header list the page wants). */
  requestHeaders: string | null;
  /** The request's credentials mode. */
  credentials: RequestCredentials;
  /** The SW's own origin - the Origin the browser sent. */
  engineOrigin: string;
}): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-origin": input.engineOrigin,
    "access-control-allow-methods": input.requestMethod || "GET",
    "access-control-max-age": "86400",
  };
  if (input.requestHeaders) h["access-control-allow-headers"] = input.requestHeaders;
  if (input.credentials === "include") h["access-control-allow-credentials"] = "true";
  return h;
}
