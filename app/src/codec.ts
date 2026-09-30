/* URL codec (TS side mirrors crates/rewriter/src/encode.rs).
   Destination encoded as base64url under a configurable prefix. The
   prefix is swappable so the URL shape can rotate (Phase 2): the SW
   accepts an zl:config message to change the prefix at runtime, so a
   deployment can rotate its path shape without a client rebuild.

   Issue #32 removed the "mirror" scheme (encode the destination
   verbatim under /m/): it placed the real upstream URL in the
   address bar, history and every page-visible route string, which is
   the exact leak class #32 closes. setScheme now takes a prefix
   only; a persisted mirror config coerces to the default scheme on
   restore, and zl:config rejects a scheme field other than "b64u".

   Bug-scout note: the SW previously hard-coded "/j/" in its route
   check, the JsRewriter ctor and rewriteCss calls while decoding used
   the rotated prefix: encoding and decoding disagreed after an
   zl:config rotation. Everything now goes through the helpers below. */

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* Runtime-configurable route prefix. The default must match
   crates/rewriter/src/config.rs (RewriteConfig::default). */
let prefix = "/j/";

export function setScheme(p: string): void {
  prefix = p.endsWith("/") || p === "" ? p : p + "/";
}

export function currentPrefix(): string {
  return prefix;
}

/** True when a same-origin request path belongs to the engine (as
    opposed to engine assets like /sw.js, /bootstrap.js, /devtools.html).
    Must stay in lockstep with decodePath. */
export function isEnginePath(path: string): boolean {
  return path === prefix || path.startsWith(prefix);
}

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL[n & 63];
  }
  return out;
}

export function b64uDecode(s: string): Uint8Array | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of s) {
    const v = B64URL.indexOf(c);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Absolute destination URL -> engine-local path. */
export function encodeDest(dest: string): string {
  return prefix + b64uEncode(ENC.encode(dest));
}

/** Engine-local path -> destination URL, or null if not ours. */
export function decodePath(path: string): string | null {
  const i = path.indexOf(prefix);
  if (i < 0) return null;
  const b64 = path.slice(i + prefix.length).split(/[?#]/)[0];
  const bytes = b64uDecode(b64);
  if (!bytes) return null;
  return DEC.decode(bytes);
}

/** Schemes the engine never routes: the browser owns blob:, data: and
    about: natively (createObjectURL media, blob workers, generated
    downloads, data: documents). The SW fetch handler passes these
    through before any route decoding (1.5 Silicide regression anchor). */
export function isOpaqueUrl(u: URL): boolean {
  return u.protocol !== "http:" && u.protocol !== "https:";
}

/** Request destinations whose script responses get the worker
    prelude prepended (classic + shared workers; service-worker
    scripts are never intercepted by another SW, by browser rules). */
export function isWorkerDestination(d: string): boolean {
  return d === "worker" || d === "sharedworker";
}

/** Same-origin paths the engine serves itself and must never route or
    reroute (finding 3: the referrer fallback must not capture them).
    Mirrors the dist path gate in app/scripts/check-dist-paths.mjs. */
export function isEngineAsset(path: string): boolean {
  switch (path) {
    case "/sw.js":
    case "/bootstrap.js":
    case "/prelude.js":
    case "/worker-prelude.js":
    case "/devtools.html":
    case "/devtools.js":
    case "/index.html":
    case "/rewriter_wasm.js":
    case "/rewriter_wasm_bg.wasm":
    case "/wisp_wasm.js":
    case "/wisp_wasm_bg.wasm":
      return true;
    default:
      return false;
  }
}

/** Peel nested engine routes: older dists rewrapped bound routes on
    every rewrite pass, so a decoded destination can itself be an
    engine route on any host (the live Google 404 chain was 4+ layers
    deep). Iterates until the current value stops looking like an
    engine route, bounded to 8 hops. Non-route input is returned
    unchanged; undecodable tail routes return the last decodable
    value, never null. Mirrors unwrap_engine_route in config.rs. */
export function unwrapDest(dest: string): string {
  let cur = dest;
  for (let hop = 0; hop < 8; hop++) {
    if (!/^https?:\/\//.test(cur)) return cur;
    let u: URL;
    try {
      u = new URL(cur);
    } catch {
      return cur;
    }
    if (!isEnginePath(u.pathname)) return cur;
    const inner = decodePath(u.pathname);
    if (!inner || inner === cur) return cur;
    cur = inner;
  }
  return cur;
}

/** Recover the real home of an escaped same-origin fetch (finding 3).
    A rewritten page is served from an engine route; a fetch that
    escapes to the engine origin (relative URL the page could not know
    was wrong) is rerouted against the origin of the page's own
    destination, recovered from the request referrer. Returns the
    recovered absolute URL, or null when the referrer is not a decodable
    engine route. Compat fallback only since #33: the requesting
    client's virtual context resolves first. */
export function referrerDest(referrer: string, path: string): string | null {
  let ref: URL;
  try {
    ref = new URL(referrer);
  } catch {
    return null;
  }
  if (!isEnginePath(ref.pathname)) return null;
  const pageDest = decodePath(ref.pathname);
  if (!pageDest) return null;
  let home: URL;
  try {
    home = new URL(pageDest);
  } catch {
    return null;
  }
  if (home.protocol !== "http:" && home.protocol !== "https:") return null;
  try {
    return new URL(path, home.origin).href;
  } catch {
    return null;
  }
}
