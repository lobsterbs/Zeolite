/* #134: runtime-built module asset recovery. React-style chunks
   mint flat module asset names (<hash>.module.css) at runtime;
   they resolve against the page origin and 404 there, while the
   real assets live on CDN directories the page itself loaded
   script/style from. This registry records those directories per
   virtual page origin and retries failed flat-named asset (script, style, runtime-built binaries)
   requests against them. Global by construction: everything comes
   from observed loads, never a per-site table. */

import { DIAG } from "./diag";

export type FlatFetch = (url: string, init: { method: string; headers: Headers }) => Promise<Response>;

const ASSET_BASES_PER_ORIGIN = 4;
const ASSET_BASES_TOTAL = 128;
const assetBases = new Map<string, string[]>();

/* #134 residual: the registry is not script/style-only. Runtime-built
   binary names (a glb or fragment minted at runtime, a hashed image)
   404 at the page origin exactly like module css; recover them too.
   Documents and workers stay out: a flat-named navigation miss must
   surface honestly, and worker code has its own pipeline. */
const RECOVERABLE_DESTS = new Set(["script", "style", "image", "video", "audio", "font", "empty"]);

export function isRecoverableAssetDest(dest: string): boolean {
  return RECOVERABLE_DESTS.has(dest);
}

export function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

/** Record the directory of a successfully loaded cross-origin
    script/style asset as a candidate base for the page origin. */
export function recordAssetBase(initiator: string, assetUrl: string): void {
  const page = originOf(initiator);
  const asset = originOf(assetUrl);
  if (!page || !asset || page === asset) return;
  const cut = assetUrl.lastIndexOf("#");
  const clean = cut >= 0 ? assetUrl.slice(0, cut) : assetUrl;
  const dir = clean.slice(0, clean.lastIndexOf("/") + 1);
  if (!/^https?:/i.test(dir)) return;
  const list = assetBases.get(page) ?? [];
  const i = list.indexOf(dir);
  if (i >= 0) list.splice(i, 1);
  list.unshift(dir);
  if (list.length > ASSET_BASES_PER_ORIGIN) list.length = ASSET_BASES_PER_ORIGIN;
  assetBases.set(page, list);
  if (assetBases.size > ASSET_BASES_TOTAL) {
    const oldest = assetBases.keys().next();
    if (!oldest.done) assetBases.delete(oldest.value);
  }
}

/** A flat name is a single path segment: no directories at all. */
export function isFlatPath(pathname: string): boolean {
  return /^\/[^/]+$/.test(pathname);
}

/** #143: runtime-built module assets are minted against the
    page DIRECTORY too, not just the origin root: github repo
    pages resolved React chunk css as
    /<owner>/<repo>/<chunk>.<hash>.module.css, which the root-only
    flat gate rejected, so no CDN retry ever fired and the React
    app never booted. Accept a short path whose FINAL segment is
    the minted name; deeper paths must carry a content hash or a
    .module. marker so page routes are never retried against
    CDN bases. */
export function isRecoverableAssetPath(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : "";
  if (!last) return false;
  if (segs.length === 1) return true;
  /* #503: upload-session and deep CDN asset paths carry 5-8 segments;
     the same mint-marker discipline (a content hash or a .module. marker
     or the dotted-hash shape) still decides the final segment, so page
     routes stay out. Past 8 segments the retry is refused: deeper tails
     are API shapes, not minted assets. */
  if (segs.length > 8) return false;
  if (/[0-9a-f]{6,}/i.test(last) || last.includes(".module.")) return true;
  /* #259: SvelteKit mints hashed asset names with a base64ish
     middle segment (brave-logo-small.Bdzj7Bzm.svg) at runtime
     against the page origin, while the real asset sits on an
     observed CDN base. Accept the dotted-hash shape; the retry
     itself stays gated by upstream status, MIME and the recorded
     base list. */
  return /^[^/]+\.[A-Za-z0-9_-]{6,12}\.[a-z0-9]{1,8}$/i.test(last);
}

/** Observed-base count for the diagnostics at the fetch seam. */
export function assetBaseCount(initiator: string): number {
  return (assetBases.get(originOf(initiator)) ?? []).length;
}

function mimeOkFor(dest: string, ct: string): boolean {
  const c = (ct || "").split(";")[0].trim().toLowerCase();
  if (dest === "style") return c === "text/css";
  if (dest === "script") {
    return (
      c === "text/javascript" ||
      c === "application/javascript" ||
      c === "application/ecmascript" ||
      c.endsWith("+javascript")
    );
  }
  /* Binary asset dests: octet-stream passes everywhere (CDNs serve
     glb, mp4 and font binaries that way) and each element dest also
     accepts its own MIME family. A bare fetch (dest "empty") has no
     family to check, so its gate is negative: never an HTML soft-404,
     never a plain-text miss. */
  const octet = c === "application/octet-stream" || c === "binary/octet-stream";
  if (dest === "image") return c.startsWith("image/") || octet;
  if (dest === "video") return c.startsWith("video/") || octet;
  if (dest === "audio") return c.startsWith("audio/") || octet;
  if (dest === "font")
    return octet || c.includes("font") || c.includes("woff") || c.includes("ttf") || c.includes("otf");
  return octet || (c !== "" && c !== "text/html" && c !== "text/plain");
}

/** Retry a failed flat-named asset (script, style, or a runtime-built
    binary) against the page's recorded
    asset bases. Cookie/origin/referer never ride along: the candidate
    is a different origin and must not see this page's jar. */
export async function recoverFlatAsset(
  initiator: string,
  target: string,
  dest: string,
  reqHeaders: Headers,
  fetchUpstream: FlatFetch,
  /* #259: the correct base can sit fourth in the LRU list on a
     page that loads many script chunks after its CSS, so walk all
     recorded bases. */
  maxTries = ASSET_BASES_PER_ORIGIN,
): Promise<{ url: string; resp: Response } | null> {
  if (!isRecoverableAssetDest(dest)) return null;
  if (!initiator) return null;
  const bases = assetBases.get(originOf(initiator)) ?? [];
  if (bases.length === 0) return null;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (!isRecoverableAssetPath(u.pathname)) return null;
  const safe = new Headers();
  for (const h of ["user-agent", "accept", "accept-language"]) {
    const v = reqHeaders.get(h);
    if (v) safe.set(h, v);
  }
  const flat = u.pathname.split("/").filter(Boolean).pop() || "";
  if (!flat) return null;
  /* A bare fetch() has no destination signal, so gate on an
     extension: runtime-built binary assets (a glb, a fragment)
     carry one; beacon-shaped single-segment misses do not and
     must not mint CDN retries. */
  if (dest === "empty") {
    const dot = flat.lastIndexOf(".");
    if (dot < 1 || flat.length - dot > 9) return null;
  }
  for (const base of bases.slice(0, maxTries)) {
    let cand: URL;
    try {
      /* #503: session-shaped assets carry query material (a gsessionid);
         the retry must be the same request against the observed base,
         so the original search rides along. */
      cand = new URL(flat + u.search, base);
    } catch {
      continue;
    }
    try {
      const r = await fetchUpstream(cand.href, { method: "GET", headers: safe });
      if (r.ok && mimeOkFor(dest, r.headers.get("content-type") ?? "")) return { url: cand.href, resp: r };
      await r.body?.cancel().catch(() => undefined);
    } catch {
      /* try the next base */
    }
  }
  return null;
}


/* #296: page JS that does src-surgery on its own opaque script token
   mints flag-segment chunk paths (/httpd=1/exm=<mods>/ed=1/cb=.../m=<mod>)
   that resolve under the virtual page origin and 404 upstream. The real
   chunk URLs live on the base of the scripts the page itself loaded, so
   record the FULL real URL of every successfully served script
   destination (same-origin included - the google case is same-origin,
   which is exactly why the cross-origin #134 registry never saw it) and
   retry a flag-shaped miss against bases derived from those. */
const SCRIPT_URLS_PER_ORIGIN = 8;
const SCRIPT_URLS_TOTAL = 64;
const scriptUrls = new Map<string, string[]>();

/** Record the full real URL of a successfully served script destination. */
export function recordScriptUrl(initiator: string, url: string): void {
  const page = originOf(initiator);
  if (!page || !/^https?:/i.test(url)) return;
  const clean = url.split("#")[0];
  const list = scriptUrls.get(page) ?? [];
  const i = list.indexOf(clean);
  if (i >= 0) list.splice(i, 1);
  list.unshift(clean);
  if (list.length > SCRIPT_URLS_PER_ORIGIN) list.length = SCRIPT_URLS_PER_ORIGIN;
  /* #358: Map ordering must reflect recency, so re-set an
     existing origin by delete-then-set; otherwise keys().next()
     evicts the first-INSERTED origin, not the least-recently-used. */
  scriptUrls.delete(page);
  scriptUrls.set(page, list);
  if (scriptUrls.size > SCRIPT_URLS_TOTAL) {
    const oldest = scriptUrls.keys().next();
    if (!oldest.done) scriptUrls.delete(oldest.value);
  }
}

const FLAG_SEG = /^([a-z][a-z0-9_-]{0,30})=/i;
const GOOGLE_FLAG_KEYS = new Set(["httpd", "exm", "ed", "cb", "m", "udm", "sxsrf", "sca_esv"]);
const MIN_GOOGLE_FLAGS = 2;
const FLAG_RECOVERY_REQUESTS_PER_CALL = 4;
const FLAG_RECOVERY_REQUESTS_PER_ORIGIN = 64;
const FLAG_RECOVERY_DISTINCT_TARGETS_PER_ORIGIN = 16;
const FLAG_RECOVERY_ORIGINS = 128;
const flagRecoveryRequests = new Map<string, number>();
const flagRecoveryTargets = new Map<string, Set<string>>();

interface GoogleMssPath {
  token: string;
  app: string;
  tail: string;
}

/* Google rotates the leading path token while keeping the observed
   module base shape stable. Keep this parser deliberately specific:
   arbitrary deep application routes must not gain a CDN retry path. */
function parseGoogleMssPath(pathname: string): GoogleMssPath | null {
  const m = /^\/([A-Za-z0-9_-]{24,128})\/_\/mss\/([A-Za-z0-9._-]{1,80})\/_\/js\/(k=[^/]+(?:\/.*)?)$/.exec(pathname);
  return m ? { token: m[1], app: m[2], tail: m[3] } : null;
}

/** A Google flag-surgery path carries multiple known Google flag names.
    Generic key=value path segments are common in unrelated applications. */
export function isFlagSurgeryPath(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean);
  const keys = segs.flatMap((s) => {
    const match = FLAG_SEG.exec(s);
    return match ? [match[1].toLowerCase()] : [];
  });
  return keys.filter((key) => GOOGLE_FLAG_KEYS.has(key)).length >= MIN_GOOGLE_FLAGS;
}

/** Retry a known Google flag-shaped script miss against bases derived
    from the page's successfully served scripts. Attempts are bounded
    both per call and per page origin; failed response bodies are
    cancelled. Gate: 200 + JS content type. Cookie/origin/referer never
    ride along. */
export async function recoverFlagSurgeryScript(
  initiator: string,
  target: string,
  reqHeaders: Headers,
  fetchUpstream: FlatFetch,
  traceId = "",
): Promise<{ url: string; resp: Response } | null> {
  const miss = (reason: string) => {
    if (!traceId) return;
    DIAG.emit({
      traceId,
      requestId: traceId,
      category: "REWRITE",
      severity: "warning",
      stage: "UPSTREAM_RESPONSE",
      message: "flag-surgery script recovery miss: " + reason,
      url: target,
    });
  };
  if (!initiator) return null;
  const pageOrigin = originOf(initiator);
  const cands = scriptUrls.get(pageOrigin) ?? [];
  if (cands.length === 0) {
    miss("no recorded script URLs for this origin");
    return null;
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (!isFlagSurgeryPath(u.pathname)) return null;
  if (!pageOrigin) return null;

  /* Count unique target script URLs, not loader retries. Google retries
     identical module URLs several times when one 404s; those retries
     must not starve other distinct chunks on the same page. */
  const targetKey = u.origin + u.pathname + u.search;
  const attempted = flagRecoveryTargets.get(pageOrigin) ?? new Set<string>();
  if (attempted.has(targetKey)) {
    miss("target URL already attempted");
    return null;
  }
  if (attempted.size >= FLAG_RECOVERY_DISTINCT_TARGETS_PER_ORIGIN) {
    miss("per-origin distinct-target budget already exhausted");
    return null;
  }
  attempted.add(targetKey);
  flagRecoveryTargets.delete(pageOrigin);
  flagRecoveryTargets.set(pageOrigin, attempted);
  if (flagRecoveryTargets.size > FLAG_RECOVERY_ORIGINS) {
    const oldest = flagRecoveryTargets.keys().next();
    if (!oldest.done) flagRecoveryTargets.delete(oldest.value);
  }

  const safe = new Headers();
  for (const h of ["user-agent", "accept", "accept-language"]) {
    const v = reqHeaders.get(h);
    if (v) safe.set(h, v);
  }
  const tried = new Set<string>();
  let uMss: GoogleMssPath | null = null;
  uMss = parseGoogleMssPath(u.pathname);

  /* Google AI Mode's token-prefixed mss route. The upstream token is
     session/page-specific, so reuse only a base observed on this exact
     Google origin and app namespace, then replace the full tokenized
     tail with the target's current module path. */
  if (uMss) {
    const candidates = new Set<string>();
    for (const c of cands) {
      let cu: URL;
      try {
        cu = new URL(c);
      } catch {
        continue;
      }
      if (cu.origin !== u.origin || cu.origin !== pageOrigin) continue;
      const observed = parseGoogleMssPath(cu.pathname);
      if (!observed || observed.app !== uMss.app) continue;
      const prefix = cu.pathname.slice(0, cu.pathname.indexOf("/_/js/") + "/_/js/".length);
      candidates.add(cu.origin + prefix + uMss.tail + u.search);
    }
    if (candidates.size === 0) {
      miss("no observed Google mss script base for app " + uMss.app);
      return null;
    }
    for (const candUrl of [...candidates].slice(0, FLAG_RECOVERY_REQUESTS_PER_CALL)) {
      if ((flagRecoveryRequests.get(pageOrigin) ?? 0) >= FLAG_RECOVERY_REQUESTS_PER_ORIGIN) {
        miss("per-origin candidate request budget exhausted");
        return null;
      }
      if (tried.has(candUrl)) continue;
      tried.add(candUrl);
      const attempts = (flagRecoveryRequests.get(pageOrigin) ?? 0) + 1;
      flagRecoveryRequests.delete(pageOrigin);
      flagRecoveryRequests.set(pageOrigin, attempts);
      try {
        const r = await fetchUpstream(candUrl, { method: "GET", headers: safe });
        if (r.ok && mimeOkFor("script", r.headers.get("content-type") ?? "")) return { url: candUrl, resp: r };
        await r.body?.cancel().catch(() => undefined);
      } catch {
        /* try the next observed mss base */
      }
    }
    miss(tried.size + " observed Google mss bases answered without JavaScript");
    return null;
  }

  /* Existing Google flag-surgery behavior for non-mss paths. */
  if ((flagRecoveryRequests.get(pageOrigin) ?? 0) >= FLAG_RECOVERY_REQUESTS_PER_ORIGIN) {
    miss("per-origin candidate request budget exhausted");
    return null;
  }
  for (const c of cands.slice(0, 3)) {
    let cu: URL;
    try {
      cu = new URL(c);
    } catch {
      continue;
    }
    const segs = cu.pathname.split("/");
    const fi = segs.findIndex((sg) => FLAG_SEG.test(sg));
    const bases: string[] = [];
    if (fi > 0) {
      const cut = segs.slice(0, fi).join("/");
      if (!bases.includes(cut)) bases.push(cut);
    }
    const dir = cu.pathname.slice(0, cu.pathname.lastIndexOf("/") + 1).replace(/\/$/, "");
    if (!bases.includes(dir)) bases.push(dir);
    const tails = [u.pathname];
    const stripped = u.pathname.replace(/^\/[^/]+\//, "/");
    if (stripped !== u.pathname) tails.push(stripped);
    for (const b of bases) {
      for (const tail of tails) {
        const candUrl = cu.origin + b + tail + (u.search || "");
        if (tried.has(candUrl)) continue;
        if (tried.size >= FLAG_RECOVERY_REQUESTS_PER_CALL) {
          miss("stopped at the per-call cap after " + tried.size + " candidates");
          return null;
        }
        if ((flagRecoveryRequests.get(pageOrigin) ?? 0) >= FLAG_RECOVERY_REQUESTS_PER_ORIGIN) {
          miss("per-origin candidate request budget exhausted");
          return null;
        }
        tried.add(candUrl);
        const attempts = (flagRecoveryRequests.get(pageOrigin) ?? 0) + 1;
        flagRecoveryRequests.delete(pageOrigin);
        flagRecoveryRequests.set(pageOrigin, attempts);
        try {
          const r = await fetchUpstream(candUrl, { method: "GET", headers: safe });
          if (r.ok && mimeOkFor("script", r.headers.get("content-type") ?? "")) return { url: candUrl, resp: r };
          await r.body?.cancel().catch(() => undefined);
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  miss(tried.size + " candidate URLs tried, none answered 200 + javascript");
  return null;
}

/* Test seam: clear the registry between cases. */
export function resetAssetBases(): void {
  assetBases.clear();
  scriptUrls.clear();
  flagRecoveryRequests.clear();
  flagRecoveryTargets.clear();
}
