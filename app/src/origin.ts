/* Virtual-origin request headers (issue #23).

   Proxied documents live on the engine origin, so the browser stamps
   every request with the engine's own facts: Sec-Fetch-Site says
   same-origin (page and route share the engine origin), and Origin, when
   sent at all, names the engine. Both are wrong from the target's
   perspective. A request the page experiences as same-origin (POST to
   its own backend) arrives upstream with a foreign Origin or none, and
   strict origin checks reject it (chatgpt.com: "Invalid request
   origin").

   The service worker knows the virtual truth: the initiator (the
   controlling page's decoded destination) and the target. This module
   turns those into the header decisions a real browser would have made.
   Pure code: no self.location, no fetch, trivially testable. */

export interface VirtualOriginHeaders {
  /** Origin value to send; absent = send none. */
  origin?: string;
  /** Recomputed Sec-Fetch-Site; absent = send none (the engine-observed
      value is never forwarded upstream). */
  secFetchSite?: "same-origin" | "same-site" | "cross-site";
}

/** Site-sameness, registrable-domain style but coarse: one hostname is
    same-site with another when one is a dot-suffix of the other. This
    is wider than the PSL in exotic cases (a.b.co.uk vs c.co.uk), never
    narrower, and only widens the "same-site" label. */
function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith("." + b) || b.endsWith("." + a);
}

/** Header decisions for a proxied request, from the virtual initiator
    and target. Unknown initiator or an unparseable / non-http(s) URL:
    every decision is "send none" (fail closed; the engine origin must
    never leak upstream). */
export function virtualOriginHeaders(
  initiator: string | null | undefined,
  target: string,
  method: string,
  mode: string,
): VirtualOriginHeaders {
  if (!initiator) return {};
  let ti: URL;
  let ii: URL;
  try {
    ti = new URL(target);
    ii = new URL(initiator);
  } catch {
    return {};
  }
  if ((ti.protocol !== "https:" && ti.protocol !== "http:") || (ii.protocol !== "https:" && ii.protocol !== "http:")) {
    return {};
  }
  const out: VirtualOriginHeaders = {};
  /* A real browser sends Origin on anything that is not GET or HEAD,
     and on every CORS request regardless of method. */
  const sendOrigin = (method !== "GET" && method !== "HEAD") || mode === "cors";
  if (sendOrigin) out.origin = ii.origin;
  out.secFetchSite =
    ii.origin === ti.origin ? "same-origin" : sameSite(ii.hostname, ti.hostname) ? "same-site" : "cross-site";
  return out;
}
