/* #134: runtime-built module asset recovery. React-style chunks
   mint flat module asset names (<hash>.module.css) at runtime;
   they resolve against the page origin and 404 there, while the
   real assets live on CDN directories the page itself loaded
   script/style from. This registry records those directories per
   virtual page origin and retries failed flat-named asset (script, style, runtime-built binaries)
   requests against them. Global by construction: everything comes
   from observed loads, never a per-site table. */

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
  maxTries = 3,
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
  if (!isFlatPath(u.pathname)) return null;
  const safe = new Headers();
  for (const h of ["user-agent", "accept", "accept-language"]) {
    const v = reqHeaders.get(h);
    if (v) safe.set(h, v);
  }
  const flat = u.pathname.slice(1);
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
      cand = new URL(flat, base);
    } catch {
      continue;
    }
    try {
      const r = await fetchUpstream(cand.href, { method: "GET", headers: safe });
      if (r.ok && mimeOkFor(dest, r.headers.get("content-type") ?? "")) return { url: cand.href, resp: r };
    } catch {
      /* try the next base */
    }
  }
  return null;
}

/* Test seam: clear the registry between cases. */
export function resetAssetBases(): void {
  assetBases.clear();
}
