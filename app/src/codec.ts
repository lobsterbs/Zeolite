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
const DEC_STRICT = new TextDecoder("utf-8", { fatal: true });

/* ---- keyed opaque routes (issue #55) ------------------------------- */

/** SW-realm route key: 16 raw bytes, or null for the legacy codec.
    Page and worker realms never hold a copy, so their own module
    instances keep the legacy encoding by construction. */
let routeKey: Uint8Array | null = null;

/** Decode history: every key this deployment minted, newest first.
    Minting uses routeKey (the newest); decodePath tries each key in
    order, so a restart that minted a fresh key keeps routes already
    handed to pages, history and the address bar decodable instead of
    stranding them (#55). */
let routeKeys: Uint8Array[] = [];

/** Activate the keyed codec (base64url of 16 raw bytes), or null to
    return to the legacy codec. Anything that is not a decodable
    16-byte key degrades to legacy - never a half-keyed state. */
export function setRouteKey(b64: string | null): void {
  const bytes = b64 === null ? null : b64uDecode(b64);
  routeKey = bytes && bytes.length === 16 ? bytes : null;
  routeKeys = routeKey ? [routeKey] : [];
}

/** Activate the keyed codec with the full decode history (base64url
    of 16 raw bytes each, newest first, as loaded from ./routekey).
    Same degraded rule as setRouteKey: anything that is not a
    decodable 16-byte key is dropped; an empty list is the legacy
    codec. The first entry is the minting key. */
export function setRouteKeys(b64s: string[]): void {
  const keys = b64s
    .map((b) => b64uDecode(b))
    .filter((k): k is Uint8Array => !!k && k.length === 16);
  routeKeys = keys;
  routeKey = keys[0] ?? null;
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
  /* #100: the u64 length word keeps only the length's low byte
     ((len as u64) << 56 on the Rust side); an unmasked BigInt kept
     the high bits, so destinations >= 255 bytes minted an IV the
     Rust decode rejected as a rotation. */
  let last = BigInt(msg.length & 0xff) << 56n;
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

/** Decode a v1 keyed token body to its MAC-verified payload string.
    Fails closed (null) on: no key, invalid UTF-8 or an IV that does
    not reproduce (wrong key, tampered token). The payload bound is
    the caller's: route tokens require an http(s) destination, the
    #63 navigation-handle payload carries its own tag. */
function keyedPayload(key: Uint8Array | null, bytes: Uint8Array): string | null {
  if (!key || bytes.length < 17 || bytes[0] !== 1) return null;
  const iv = bytes.slice(1, 17);
  const ct = bytes.slice(17);
  const d = new Uint8Array(ct.length);
  // One keystream block covers 8 body bytes; cache per block instead
  // of re-running SipHash for every single byte. This decode runs on
  // every keyed route request, so the 8x cut matters.
  const blocks: (Uint8Array | undefined)[] = [];
  for (let i = 0; i < ct.length; i++) {
    const bi = i >> 3;
    let ks = blocks[bi];
    if (!ks) {
      ks = keystreamBlock(key, iv, bi);
      blocks[bi] = ks;
    }
    d[i] = ct[i] ^ ks[i & 7];
  }
  let payload: string;
  try {
    payload = DEC_STRICT.decode(d);
  } catch {
    return null;
  }
  if (concatBytes(destMac(key, d, 1), destMac(key, d, 2)).some((b, i) => b !== iv[i])) {
    return null;
  }
  return payload;
}

/** Route-token decode: keyedPayload plus the http(s) destination
    bound - the engine routes nothing else, so anything else is not a
    valid token. Mirrors keyed_decode in crates/rewriter/src/encode.rs
    byte for byte. */
function keyedDecode(key: Uint8Array | null, bytes: Uint8Array): string | null {
  const payload = keyedPayload(key, bytes);
  if (payload === null || !/^https?:\/\//.test(payload)) return null;
  return payload;
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

/* ---- opaque initial-navigation handles (issue #63, #54 design D) --- */

/** Handle route marker: the engine-origin path a host navigates a
    frame to instead of a plaintext ?url= embed. The tail is a keyed
    token carrying the handle payload, so the address bar, history
    and the network panel see an opaque token only. */
export const NAVH = "/__zl_navh__";
/** Payload tag: disjoint from any http(s) destination string, so a
    handle token can never collide with a route token's payload. */
const NAVH_TAG = "zl:navh:";
/** Mint-to-navigate window (ms). Short by design: the handle covers
    the initial load only. */
export const NAVH_TTL_MS = 120_000;

/** Mint an opaque navigation handle for an absolute http(s)
    destination: b64u of a keyed token whose payload is
    NAVH_TAG || expiry || ":" || dest. Stateless by construction -
    nothing to persist, so a SW restart cannot strand it - and decode
    walks the full route-key history, so a minted handle survives a
    key rotation too. TTL-only, not single-use: the issue allows
    either, and single-use would need SW-side state that a restart
    could strand (the exact cold-start hazard it warns about). Null =
    no route key (storage degraded) or a non-mintable destination:
    the SW refuses instead of answering a legacy-shape handle, which
    would carry the destination decodably - the leak #63 exists to
    stop. */
export function encodeNavHandle(dest: string, ttlMs: number = NAVH_TTL_MS): string | null {
  if (!routeKey || !mintableDest(dest)) return null;
  return b64uEncode(keyedToken(routeKey, NAVH_TAG + String(Date.now() + ttlMs) + ":" + dest));
}

/** Handle tail -> destination, or null (bad tail, no key held, wrong
    tag, non-mintable destination, or expired). */
export function decodeNavHandle(token: string): string | null {
  const bytes = b64uDecode(token);
  if (!bytes) return null;
  for (const k of routeKeys) {
    const payload = keyedPayload(k, bytes);
    if (payload === null || !payload.startsWith(NAVH_TAG)) continue;
    const rest = payload.slice(NAVH_TAG.length);
    const colon = rest.indexOf(":");
    if (colon < 0) continue;
    const exp = Number(rest.slice(0, colon));
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    const dest = rest.slice(colon + 1);
    if (mintableDest(dest)) return dest;
  }
  return null;
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
    decode: a v1 keyed token decodes with any key in the decode
    history (newest first) and fails closed when none match; legacy
    tails always decode, so routes minted before the key existed keep
    working. */
export function decodePath(path: string): string | null {
  const bytes = tailBytes(path);
  if (!bytes) return null;
  if (bytes.length >= 17 && bytes[0] === 1) {
    for (const key of routeKeys) {
      const dest = keyedDecode(key, bytes);
      if (dest) return dest;
    }
    return null;
  }
  /* #73: the legacy branch fails closed exactly like keyedDecode -
     the engine routes http(s) destinations only, so anything else
     is not a valid destination. Strict UTF-8 too: the lossy decoder
     handed back a replacement-character string for garbage tails. */
  let dest: string;
  try {
    dest = DEC_STRICT.decode(bytes);
  } catch {
    return null;
  }
  return /^https?:\/\//.test(dest) ? dest : null;
}

/** Recover a concatenated route tail (the URL-literal gap). The JS
    literal pass mints a keyed route for any string literal that
    looks like an absolute URL, but a literal can be a FRAGMENT the
    page later completes by string concatenation ("https://x" +
    "cdn.example/img.gif"): the minted token ends up with plaintext
    appended after it, and decodePath rejects the whole tail. Retry
    every prefix length as a standalone keyed token and accept only a
    MAC-verified decode; the remainder joins the decoded destination
    verbatim. Legacy tails are refused: without a MAC, a short prefix
    decodes to anything and false positives are certain.

    Hostile-tail hardening: b64u is a bit stream, so one decode of
    the valid-char prefix yields the byte prefix that every shorter
    L decodes to, and the token IV (bytes 1..17) is identical for
    every L. One keystream block per key decrypts the first body
    bytes; unless they read "http://" or "https://" the key is wrong
    and the tail dies in O(1) - the old per-L rescan was O(tail^2)
    with a per-byte SipHash and could freeze the shared worker for
    seconds on one crafted request. Only a key that passes the gate
    pays for the per-L MAC scan, which is token-sized, not
    tail-sized. ponytail: the gate is 56 bits, but reaching the MAC
    scan without the SW-realm key is the attacker's problem, and a
    key that passes the gate is by definition the minting key. */
export function recoverPath(path: string): string | null {
  const i = path.indexOf(prefix);
  if (i < 0) return null;
  const tail = path.slice(i + prefix.length).split(/[?#]/)[0];
  if (tail.length < 23 || tail.length > 2048) return null;
  // The appended plaintext can carry non-b64u chars ("/", ".", ":");
  // decode only up to the first one - every candidate L sits before
  // it, and a shorter decode is byte-identical to the old per-L one.
  let maxL = 0;
  while (maxL < tail.length && B64URL.indexOf(tail[maxL]) >= 0) maxL++;
  if (maxL < 23) return null;
  const bytes = b64uDecode(tail.slice(0, maxL));
  if (!bytes || bytes.length < 24 || bytes[0] !== 1) return null;
  const iv = bytes.slice(1, 17);
  const ct = bytes.slice(17);
  for (const key of routeKeys) {
    // Gate: the first decrypted body bytes must read "http(s)://".
    const ks0 = keystreamBlock(key, iv, 0);
    let gate = "";
    for (let b = 0; b < 8; b++) gate += String.fromCharCode((ct[b] ?? 0) ^ ks0[b]);
    if (!gate.startsWith("http://") && !gate.startsWith("https://")) continue;
    // Full decrypt once, one keystream block per 8 body bytes.
    const d = new Uint8Array(ct.length);
    const blocks: (Uint8Array | undefined)[] = [];
    for (let k = 0; k < ct.length; k++) {
      const bi = k >> 3;
      let ks = blocks[bi];
      if (!ks) {
        ks = keystreamBlock(key, iv, bi);
        blocks[bi] = ks;
      }
      d[k] = ct[k] ^ ks[k & 7];
    }
    for (let L = 23; L <= maxL; L++) {
      if (L % 4 === 1) continue; // never a full b64u token boundary
      const cand = d.slice(0, ((3 * L) >> 2) - 17);
      if (
        concatBytes(destMac(key, cand, 1), destMac(key, cand, 2)).some((b, j) => b !== iv[j])
      ) {
        continue;
      }
      let dest: string;
      try {
        dest = DEC_STRICT.decode(cand);
      } catch {
        continue;
      }
      if (!/^https?:\/\//.test(dest)) continue;
      return dest + tail.slice(L);
    }
  }
  return null;
}

/** #113: a legacy route minted under a prefix this worker has not
    configured yet (a cold start, before the boot config lands) is
    invisible to decodePath, which knows only the configured prefix,
    so it reaches the escape seam instead of the route decode. The
    tail still names a real page: accept a two-segment path whose
    first segment is the configured prefix or the reserved legacy
    "zl" segment (host routes like /r/ are never captured), refuse
    keyed tails - fail closed, keyed decode is decodePath's job - and
    bind the payload to http(s) like every other decode. */
export function decodeLegacyRoute(path: string): string | null {
  const m = /^/([^/]+)/([A-Za-z0-9_-]+)$/.exec(path);
  if (!m) return null;
  const seg = m[1];
  const tail = m[2];
  if (seg === undefined || tail === undefined) return null;
  if (prefix !== "/" + seg + "/" && seg !== "zl") return null;
  const bytes = b64uDecode(tail);
  if (!bytes || (bytes.length >= 17 && bytes[0] === 1)) return null;
  let dest: string;
  try {
    dest = DEC_STRICT.decode(bytes);
  } catch {
    return null;
  }
  return /^https?:///.test(dest) ? dest : null;
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
    // Resolve against the page's full URL, not just its origin: a
    // directory-relative tail ("img/x.png" from /a/b/page.html) must
    // land in the page's directory. Absolute paths (leading "/")
    // still resolve to the origin root, unchanged.
    return new URL(path, home).href;
  } catch {
    return null;
  }
}

/** Anubis pass-challenge redir repair (the #52 challenge-handoff gap
    the server-side deployments close in their own proxy): the engine
    rewriter maps the challenge page's return URL literal into an
    engine route, so the pass-challenge request carries redir
    pointing at the engine origin - and the upstream deployment
    rejects a redirect target outside its allowlist
    (redirect_domain_not_allowed), so verification fails after the
    challenge completes. When redir is a decodable engine route
    (keyed or legacy), rebuild the query with the plaintext upstream
    page URL so the challenge can finish; the response redirect chain
    maps the hop back to an engine route through the ordinary
    pipeline. Returns the fixed absolute URL, or null when redir is
    absent or not a decodable engine route. */
export function passChallengeRedirFixed(dest: string): string | null {
  let u: URL;
  try {
    u = new URL(dest);
  } catch {
    return null;
  }
  const redir = u.searchParams.get("redir");
  if (!redir) return null;
  const q = redir.indexOf("?");
  const path = q < 0 ? redir : redir.slice(0, q);
  if (!isEnginePath(path)) return null;
  const decoded = decodePath(path);
  if (!decoded || !/^https?:\/\//.test(decoded)) return null;
  const out = new URL(dest);
  out.searchParams.set("redir", decoded + (q < 0 ? "" : redir.slice(q)));
  return out.href;
}
