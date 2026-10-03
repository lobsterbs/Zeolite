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
   zl:config rotation. Everything now goes through the helpers below.

   Issue #55 closes the same leak class one layer down: a base64url
   tail is reversible by anyone, the host browser included. With a
   SW-realm route key active (setRouteKey, loaded by the SW from
   ./routekey), encodeDest mints keyed tokens (0x01 || IV || dest XOR
   keystream) that only decode with that key, so a browser-visible
   route string carries no recoverable destination. Dual decode keeps
   pre-#55 routes working: legacy tails always decode; a keyed token
   without the key fails closed to null. The worker prelude keeps the
   legacy encoding (encodeDestLegacy): the prelude realm holds no
   key - a documented limit. */

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
const DEC_STRICT = new TextDecoder("utf-8", { fatal: true });

/* ---- keyed opaque routes (issue #55) ------------------------------- */

/** SW-realm route key: 16 raw bytes, or null for the legacy codec.
    Page and worker realms never hold a copy, so their own module
    instances keep the legacy encoding by construction. */
let routeKey: Uint8Array | null = null;

/** Activate the keyed codec (base64url of 16 raw bytes), or null to
    return to the legacy codec. Anything that is not a decodable
    16-byte key degrades to legacy - never a half-keyed state. */
export function setRouteKey(b64: string | null): void {
  const bytes = b64 === null ? null : b64uDecode(b64);
  routeKey = bytes && bytes.length === 16 ? bytes : null;
}

const M64 = (1n << 64n) - 1n;
function rotl64(v: bigint, n: number): bigint {
  return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64;
}
function le64(b: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(b[i + j]);
  return v;
}
function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let j = 0; j < 8; j++) out[j] = Number((v >> BigInt(8 * j)) & 0xffn);
  return out;
}
function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** One SipHash-2-4 round, the reference schedule (veorq/SipHash): v2
    gets no extra rotation after v3^=v2 and v0 none after v3^=v0. The
    token format is pinned by interop tests on both sides, so the PRF
    it rests on is pinned with it. */
function sipround(v: bigint[]): void {
  v[0] = (v[0] + v[1]) & M64;
  v[1] = rotl64(v[1], 13);
  v[1] ^= v[0];
  v[0] = rotl64(v[0], 32);
  v[2] = (v[2] + v[3]) & M64;
  v[3] = rotl64(v[3], 16);
  v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & M64;
  v[3] = rotl64(v[3], 21);
  v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & M64;
  v[1] = rotl64(v[1], 17);
  v[1] ^= v[2];
  v[2] = rotl64(v[2], 32);
}

/** SipHash-2-4 over msg with the 128-bit key, 64-bit result. */
function siphash24(key: Uint8Array, msg: Uint8Array): bigint {
  const k0 = le64(key, 0);
  const k1 = le64(key, 8);
  const v = [
    k0 ^ 0x736f6d6570736575n,
    k1 ^ 0x646f72616e646f6dn,
    k0 ^ 0x6c7967656e657261n,
    k1 ^ 0x7465646279746573n,
  ];
  let i = 0;
  for (; i + 8 <= msg.length; i += 8) {
    const m = le64(msg, i);
    v[3] ^= m;
    sipround(v);
    sipround(v);
    v[0] ^= m;
  }
  let last = BigInt(msg.length) << 56n;
  for (let j = 0; i + j < msg.length; j++) last |= BigInt(msg[i + j]) << BigInt(8 * j);
  v[3] ^= last;
  sipround(v);
  sipround(v);
  v[0] ^= last;
  v[2] ^= 0xffn;
  sipround(v);
  sipround(v);
  sipround(v);
  sipround(v);
  return (v[0] ^ v[1] ^ v[2] ^ v[3]) & M64;
}

/** Keystream block j: SipHash over IV || u32le(j) || domain 3. */
function keystreamBlock(key: Uint8Array, iv: Uint8Array, j: number): Uint8Array {
  return u64le(siphash24(key, concatBytes(iv, u32le(j), new Uint8Array([3]))));
}

/** Two SipHash MACs of the destination (domains 1 and 2) form the
    token IV: the IV is bound to the destination, so decode can verify
    a token was minted with the same key. */
function destMac(key: Uint8Array, dest: Uint8Array, dom: number): Uint8Array {
  return u64le(siphash24(key, concatBytes(dest, new Uint8Array([dom]))));
}

/** Mint a v1 keyed token: 0x01 || IV(16) || dest XOR keystream. */
function keyedToken(key: Uint8Array, dest: string): Uint8Array {
  const d = ENC.encode(dest);
  const iv = concatBytes(destMac(key, d, 1), destMac(key, d, 2));
  const out = new Uint8Array(d.length + 17);
  out[0] = 1;
  out.set(iv, 1);
  for (let i = 0; i < d.length; i++) out[17 + i] = d[i] ^ keystreamBlock(key, iv, i >> 3)[i & 7];
  return out;
}

/** Decode a v1 keyed token body. Fails closed (null) on: no key,
    invalid UTF-8, an IV that does not reproduce (wrong key, tampered
    token) or a non-http(s) destination - the engine routes nothing
    else, so anything else is not a valid token. Mirrors keyed_decode
    in crates/rewriter/src/encode.rs byte for byte. */
function keyedDecode(key: Uint8Array | null, bytes: Uint8Array): string | null {
  if (!key || bytes.length < 17 || bytes[0] !== 1) return null;
  const iv = bytes.slice(1, 17);
  const ct = bytes.slice(17);
  const d = new Uint8Array(ct.length);
  for (let i = 0; i < ct.length; i++) d[i] = ct[i] ^ keystreamBlock(key, iv, i >> 3)[i & 7];
  let dest: string;
  try {
    dest = DEC_STRICT.decode(d);
  } catch {
    return null;
  }
  if (
    concatBytes(destMac(key, d, 1), destMac(key, d, 2)).some((b, i) => b !== iv[i]) ||
    !/^https?:\/\//.test(dest)
  ) {
    return null;
  }
  return dest;
}

/** Absolute destination URL -> engine-local path. Keyed (opaque)
    when a route key is active, legacy base64url otherwise. */
export function encodeDest(dest: string): string {
  return routeKey ? prefix + b64uEncode(keyedToken(routeKey, dest)) : encodeDestLegacy(dest);
}

/** Legacy base64url route, keyed or not. The SW uses it only where
    the receiver cannot hold the key (worker prelude init lines). */
export function encodeDestLegacy(dest: string): string {
  return prefix + b64uEncode(ENC.encode(dest));
}

/** zl:mint request validation (#54 residual 1): the SW mints a route
    only for engine-routable absolute http(s) destinations, mirroring
    the keyedDecode bound. Admitting zl:mint to proxied pages grants
    no new capability - the legacy codec is page-public and a page
    could always encode any destination itself. */
export function mintableDest(dest: string): boolean {
  let u: URL;
  try {
    u = new URL(dest);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/** Keyed per-origin site identity (#32 hardening on #55's key): a
    SipHash MAC of the origin under the route key, domain 4 (disjoint
    from the route-token domains 1-3), so the page-held storage id is
    not dictionary-reversible the way the fnv1a fallback is. Null =
    no route key = the legacy fnv1a token. */
export function keyedSiteToken(origin: string): string | null {
  if (!routeKey) return null;
  return b64uEncode(destMac(routeKey, ENC.encode(origin), 4));
}

/** Engine path -> decoded tail bytes (query and fragment stripped), or
    null when the path is not an engine route or the tail is not
    base64url. Shared by decodePath and looksKeyedToken so the two can
    never disagree about what a tail is. */
function tailBytes(path: string): Uint8Array | null {
  const i = path.indexOf(prefix);
  if (i < 0) return null;
  return b64uDecode(path.slice(i + prefix.length).split(/[?#]/)[0]);
}

/** Shape-only check: does an engine path's tail look like a v1 keyed
    token (0x01 lead, at least the 17 header bytes)? Needs no key, so
    the SW can tell a route minted under a key it no longer holds (a
    rotated key strands every old route) from a plain bad tail in its
    404 reason. Not a security decision: only keyedDecode's MAC check
    decides what actually decodes. */
export function looksKeyedToken(path: string): boolean {
  const bytes = tailBytes(path);
  return !!bytes && bytes.length >= 17 && bytes[0] === 1;
}

/** Engine-local path -> destination URL, or null if not ours. Dual
    decode: a v1 keyed token decodes with the key and fails closed
    without it; legacy tails always decode, so routes minted before
    the key existed keep working. */
export function decodePath(path: string): string | null {
  const bytes = tailBytes(path);
  if (!bytes) return null;
  if (bytes.length >= 17 && bytes[0] === 1) return keyedDecode(routeKey, bytes);
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
