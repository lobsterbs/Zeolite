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

import { decodePath, recoverPath, unwrapDest } from "./codec";

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
  /* #112 directory-shaped routes carry a plaintext tail after the
      keyed token, so decodePath alone fails; retry with recoverPath -
      the same MAC-verified recovery the request engine uses - and
      peel nested routes the same way it does. */
  const raw = decodePath(cu.pathname) ?? recoverPath(cu.pathname);
  if (!raw) return null;
  const dest = unwrapDest(raw);
  let du: URL;
  try {
    du = new URL(dest);
  } catch {
    return null;
  }
  if (du.protocol !== "https:" && du.protocol !== "http:") return null;
  return du.origin;
}

/** Upstream Referer for a request whose engine-side referrer did not
    decode to a route (#127). A page with an origin-only referrer
    policy sends the engine origin root; the virtual equivalent is
    the controlling page's origin, in the origin-only form a real
    browser sends (origin + "/"). Fail closed: null when the
    initiator is unknown, unparseable, or not http(s). */
export function virtualRefererFallback(initiator: string | null | undefined): string | null {
  if (!initiator) return null;
  let ii: URL;
  try {
    ii = new URL(initiator);
  } catch {
    return null;
  }
  if (ii.protocol !== "https:" && ii.protocol !== "http:") return null;
  return ii.origin + "/";
}

/* Full Sec-Fetch construction (2026-10-14 report): only Sec-Fetch-Site
   used to be recomputed; -Mode, -Dest and -User were copied as the
   service worker saw them, which describe the engine iframe's fetch,
   not the virtual page's request (and are absent entirely on browsers
   that hide them, #40). Build every one of them from the virtual
   facts: request mode, destination, navigation flag and the virtual
   initiator. Pure code like the rest of this module. */
export interface SecFetchHeaderSet {
  site?: "same-origin" | "same-site" | "cross-site" | "none";
  mode?: string;
  dest?: string;
  user?: "?1";
  upgradeInsecureRequests?: true;
}

export function secFetchHeaders(
  initiator: string | null | undefined,
  target: string,
  method: string,
  mode: string,
  destination: string,
): SecFetchHeaderSet {
  const vo = virtualOriginHeaders(initiator, target, method, mode);
  const dest = destination ? destination.toLowerCase() : "empty";
  if (mode === "navigate") {
    /* A navigation with no attributable initiator is a top-level
       load: a real browser sends the none/navigate/document/?1 set
       plus Upgrade-Insecure-Requests, not silence. */
    return {
      site: vo.secFetchSite ?? "none",
      mode: "navigate",
      dest: dest === "empty" ? "document" : dest,
      user: "?1",
      upgradeInsecureRequests: true,
    };
  }
  /* Subresources: site only when the initiator is known (fail
     closed, the engine origin must never leak upstream), mode and
     dest from the request's own virtual facts. Sec-Fetch-User is
     navigation-only in real browsers. */
  return { site: vo.secFetchSite, mode, dest };
}

/* Sec-CH-UA family (2026-10-14 report): the transport sends the
   active profile's UA, and a Chrome UA without client hints is a
   known bot signal (#160 class). Only when the UA actually is
   Chromium: a Firefox or Safari UA must carry no Chromium hints.
   Values are derived from the UA so they cannot contradict it.
   Deletes first, so the final UA's truth always wins over an
   earlier layer's hints. */
function chPlatform(ua: string): string {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chrome OS";
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "";
}

/* Proxy-injected hop headers. A reverse proxy in front of the SW
   origin (Render adds x-forwarded-for/-proto/-host/-port on every
   inbound request) sees its own bookkeeping headers on the engine
   request, and the generic copy loop below would forward them
   upstream. Real browsers never send them, so strict WAF zones read
   them as a proxy tell (#160: shadertoy's Cloudflare zone 403s the
   relayed document with a terse edge rejection). They describe the
   proxy->engine hop, never the virtual page. */
export const PROXY_INJECTED_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-forwarded-cluster",
  "x-real-ip",
];

export function applyChUa(headers: Headers, userAgent: string): void {
  headers.delete("sec-ch-ua");
  headers.delete("sec-ch-ua-mobile");
  headers.delete("sec-ch-ua-platform");
  const m = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (!m) return;
  const major = m[1];
  const brands = ['"Chromium";v="' + major + '"', '"Not_A Brand";v="8"'];
  if (/Chrome\/\d+/.test(userAgent)) brands.push('"Google Chrome";v="' + major + '"');
  headers.set("sec-ch-ua", brands.join(", "));
  headers.set("sec-ch-ua-mobile", /Android.+Mobile|iPhone/.test(userAgent) ? "?1" : "?0");
  const plat = chPlatform(userAgent);
  if (plat) headers.set("sec-ch-ua-platform", '"' + plat + '"');
}
