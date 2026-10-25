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

import { decodeClientUrl, recoverPath, unwrapDest } from "./codec";
import { clientHintsForUa, formatUaBrands } from "./useragent";

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
  /* #193: decodeClientUrl resolves both client shapes, the /j/ route and
     the NAVH handle (/__zl_navh__/<token>/...). decodePath alone returns
     null for a handle, which failed closed for every handle-navigated page
     (no document.cookie, no virtual-origin marker). */
  const raw = decodeClientUrl(cu) ?? recoverPath(cu.pathname);
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
    /* No virtual initiator decodes: an omnibox/typed tab load. The
       physical fetch is the engine iframe (dest "iframe"), but the
       virtual request is the tab's top-level navigation, and a real
       browser never sends dest "iframe" with site "none" - that
       impossible combo was a #160-class WAF tell. Claim the exact set
       a typed navigation produces. */
    if (!vo.secFetchSite) {
      return {
        site: "none",
        mode: "navigate",
        dest: "document",
        user: "?1",
        upgradeInsecureRequests: true,
      };
    }
    /* Initiated from a virtual page (its own navigation or an
       embedded frame): site from the virtual initiator, physical
       dest kept, and no Sec-Fetch-User - real frame loads are not
       user activation and never carry it. */
    return {
      site: vo.secFetchSite,
      mode: "navigate",
      dest: dest === "empty" ? "document" : dest,
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

export function applyChUa(headers: Headers, userAgent: string, preserveNativeHighEntropy = false): void {
  const requested = new Set<string>();
  const lowEntropy = new Set(["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
  for (const key of [...headers.keys()]) {
    if (key.startsWith("sec-ch-ua") && (!preserveNativeHighEntropy || lowEntropy.has(key))) {
      requested.add(key); headers.delete(key);
    }
  }
  const data = clientHintsForUa(userAgent);
  if (!data) return;
  headers.set("sec-ch-ua", formatUaBrands(data.brands));
  headers.set("sec-ch-ua-mobile", data.mobile ? "?1" : "?0");
  if (data.platform) headers.set("sec-ch-ua-platform", JSON.stringify(data.platform));
  // Never attach unsolicited high entropy or forward unknown physical facts.
  const values: Record<string, string | undefined> = {
    "sec-ch-ua-full-version": data.uaFullVersion === undefined ? undefined : JSON.stringify(data.uaFullVersion),
    "sec-ch-ua-full-version-list": data.fullVersionList ? formatUaBrands(data.fullVersionList) : undefined,
    "sec-ch-ua-arch": data.architecture === undefined ? undefined : JSON.stringify(data.architecture),
    "sec-ch-ua-bitness": data.bitness === undefined ? undefined : JSON.stringify(data.bitness),
  };
  for (const [key, value] of Object.entries(values)) if (requested.has(key) && value !== undefined) headers.set(key, value);
}

/* The navigation Accept a real Chromium of the claimed major sends.
   The physical browser's own Accept advertises image formats by ITS
   major (image/jxl only once Chrome 155 shipped JPEG XL decoding), so
   a 124 claim carrying a 156-shaped accept is a UA-vs-Accept
   contradiction a WAF can check. Null for non-Chromium UAs: their
   accept is whatever the page sent. */
const CHROME_NAV_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

export function navigationAccept(userAgent: string): string | null {
  const m = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (!Number.isFinite(major)) return null;
  return major >= 155
    ? CHROME_NAV_ACCEPT.replace("image/avif", "image/jxl,image/avif")
    : CHROME_NAV_ACCEPT;
}

/* Accept-Language a real Chromium sends for a profile's list: the
   first entry unweighted, the rest with Chrome's descending q values
   ("en-US,en;q=0.9", never a bare "en-US,en" join). */
export function acceptLanguageValue(languages: string[]): string {
  return languages
    .map((l, i) => (i === 0 ? l : l + ";q=" + Math.max(0.1, 1 - 0.1 * i).toFixed(1)))
    .join(",");
}
