/* Zeolite extension subsystem: browser.identity (#522).

   Firefox's identity surface is exactly two members
   (toolkit/components/extensions/child/ext-identity.js):
   getRedirectURL, a pure derivation from the extension id, and
   launchWebAuthFlow, which needs a host browser to intercept the
   redirect. The engine mounts getRedirectURL (gated on the
   "identity" permission, Firefox's identity.json schema gate) and
   byte-follows Firefox's derivation: sha1-hex of the extension id as
   the subdomain under the pref-governed redirect domain
   (extensions.allizom.org, the
   extensions.webextensions.identity.redirectDomain default in
   modules/libpref/init/all.js), the optional path appended as a URL
   pathname. The member is SYNC in Firefox's schema (a plain string
   return), so the digest is a small pure SHA-1 rather than the
   async WebCrypto path; __tests__/identity.test.ts pins the
   derivation against literal vectors computed with node's sha1.

   launchWebAuthFlow stays unmounted (firefox-inventory.ts carries
   the reason): outside a real browser the redirect URL is inert -
   there is no host auth window to intercept it. */

import type { ExtensionRecord } from "./types";

/** Pure SHA-1 (FIPS 180-1) over the UTF-8 bytes, lowercase hex. The
    input is a short id and the call is not on a hot path; WebCrypto's
    digest is async and Firefox's member is sync. */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  /* Total padded length: len + the 0x80 byte + zeros + 8 length bytes,
     a multiple of 64. */
  const blocks = ((len + 8) >> 6) + 1;
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[len] = 0x80;
  const dv = new DataView(data.buffer);
  const bitLen = len * 8;
  dv.setUint32(data.length - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(data.length - 4, bitLen >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + (f + e + k + w[i])) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** Firefox's redirect domain, the pref default Firefox itself ships. */
const REDIRECT_DOMAIN = "extensions.allizom.org";

/** Firefox's getRedirectURL: the digest subdomain under the redirect
    domain, the path appended as a URL pathname ("" keeps the bare
    "/" root; "a/b" and "/a/b" both land at /a/b, exactly as the URL
    pathname setter Firefox uses behaves). */
export function redirectUrlFor(extensionId: string, path?: string): string {
  const url = new URL("https://" + sha1Hex(extensionId) + "." + REDIRECT_DOMAIN + "/");
  url.pathname = typeof path === "string" ? path : "";
  return url.href;
}

/** The mounted browser.identity namespace; the permission gate runs
    at the mount site (runtime.ts), like the other permission-gated
    namespaces. */
export function identityNs(ext: ExtensionRecord): Record<string, unknown> {
  return {
    /* #522: path validation runs in arg-schemas.ts before this
       member; the schema-shaped answer stays sync, as in Firefox. */
    getRedirectURL: (path?: string): string => redirectUrlFor(ext.id, path),
  };
}
