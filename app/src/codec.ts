/* URL codec (TS side mirrors crates/rewriter/src/encode.rs).
   Destination encoded as base64url under a configurable prefix. The
   scheme is swappable so the URL shape can rotate (Phase 2): the SW
   accepts an zl:config message to change prefix/scheme at runtime, so a
   deployment can rotate its path shape without a client rebuild.

   Bug-scout note: the SW previously hard-coded "/j/" in its route
   check, the JsRewriter ctor and rewriteCss calls while decoding used
   the rotated prefix: encoding and decoding disagreed after an
   zl:config rotation. Everything now goes through the helpers below. */

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* Runtime-configurable scheme state. Defaults must match
   crates/rewriter/src/config.rs (RewriteConfig::default). */
let prefix = "/j/";
let scheme: "b64u" | "mirror" = "b64u";

export function setScheme(p: string, s: "b64u" | "mirror" = "b64u"): void {
  prefix = p.endsWith("/") || p === "" ? p : p + "/";
  scheme = s;
}

export function currentPrefix(): string {
  return prefix;
}

export function currentScheme(): "b64u" | "mirror" {
  return scheme;
}

/** True when a same-origin request path belongs to the engine (as
    opposed to engine assets like /sw.js, /bootstrap.js, /devtools.html).
    Must stay in lockstep with decodePath. */
export function isEnginePath(path: string): boolean {
  if (scheme === "mirror") return path === "/m/" || path.startsWith("/m/");
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
  if (scheme === "mirror") return "/m/" + dest;
  return prefix + b64uEncode(ENC.encode(dest));
}

/** Engine-local path -> destination URL, or null if not ours. */
export function decodePath(path: string): string | null {
  if (scheme === "mirror") {
    const rest = path.startsWith("/m/") ? path.slice(3) : null;
    return rest && rest.length > 0 ? rest : null;
  }
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
