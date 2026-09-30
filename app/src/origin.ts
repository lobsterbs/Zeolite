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

import { decodePath } from "./codec";

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

/** Virtual origin of a control-message sender (bug-scout fix).
    zl:docCookie and zl:wsOpen used to trust an origin field in the
    message itself, so any proxied page could claim another site's
    origin and read or write that site's jar cookies, or forge the
    per-origin WS handshake identity. The sender's own client URL is
    an engine route; its decoded destination is the only origin the
    handlers act on. Fail closed: null when the sender is unknown,
    not on the engine origin, off the engine routes, or when the
    route does not decode to an http(s) destination. Pure code like
    the rest of this module. */
export function senderVirtualOrigin(
  clientUrl: string | null | undefined,
  engineOrigin: string,
): string | null {
  if (!clientUrl) return null;
  let cu: URL;
  try {
    cu = new URL(clientUrl, engineOrigin);
  } catch {
    return null;
  }
  if (cu.origin !== engineOrigin) return null;
  const dest = decodePath(cu.pathname);
  if (!dest) return null;
  let du: URL;
  try {
    du = new URL(dest);
  } catch {
    return null;
  }
  if (du.protocol !== "https:" && du.protocol !== "http:") return null;
  return du.origin;
}
