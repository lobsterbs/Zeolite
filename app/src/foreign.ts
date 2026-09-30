/* Cross-origin request policy (issue #34).

   A controlled page's subresource requests all reach the fetch
   handler, whatever origin they name - only navigations are
   scope-bound. Before #34 the handler declined foreign-origin http(s)
   requests and the browser went direct, exposing the client IP and
   the target hostname: every fetch/XHR, EventSource, sendBeacon,
   image, stylesheet, script, media element or worker URL a page
   built at runtime (or inserted through the HTML parser, CSS url(),
   srcset - surfaces no page-side hook can cover) escaped the engine.

   The policy classifies such a request before the SW answers it:

   - passthrough: the requesting client is not a proxied document (no
     client URL, or a client URL that does not decode to an engine
     destination - the embedder app's own pages). Its cross-origin
     traffic is its own business and keeps the direct browser path
     with the #30 escape telemetry. Failing closed to passthrough for
     an unknown client is the safe direction for the host app.
   - preflight: a CORS preflight (OPTIONS + access-control-request-
     method) from a proxied document. The engine is the proxy the
     page is same-origin to, and the target's own CORS policy never
     applied to engine-routed responses (applyEngineCors replaces
     the target's CORS facts with the engine's), so the preflight is
     answered by the engine for exactly the method and headers the
     page asked for; the actual request then routes like any other.
   - route: a proxied document's request. The full URL is the
     destination and the existing pipeline (SSRF policy, header
     surgery, per-origin cookie jar, transport, rewriter, netLog)
     serves it, so no browser-direct request ever leaves.

   Pure code so the decision table is unit-tested; the SW owns the
   async parts (client lookup) and stays thin. */

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
