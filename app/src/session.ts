/* Encrypted session export/import (Phase 7, 1.7 Sulfide).

   A session blob is a self-describing, encrypted JSON envelope:

     { zlSession: 1, alg: "AES-256-GCM/PBKDF2-SHA256",
       iter: 120000, salt: b64, iv: b64, data: b64 }

   The plaintext payload (cookies, tabs, caller-supplied extras) never
   appears in the blob: only the WebCrypto ciphertext does. The key is
   never stored - it is derived from the passphrase with PBKDF2-SHA256
   on both export and import, so a blob without its passphrase is
   indistinguishable from noise. GCM's tag makes tampering detectable.

   This format is a user session artifact, clearly separate from
   engine configuration (config keys, wisp endpoints, extension
   registrations): it never carries those. Base64 uses a hand-rolled
   alphabet encoder so no environment (worker, test runner) needs
   btoa/atob. */

const ALG = "AES-256-GCM/PBKDF2-SHA256";
export const SESSION_ITERATIONS = 120_000;

export interface SessionBlob {
  zlSession: 1;
  alg: string;
  iter: number;
  salt: string;
  iv: string;
  data: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Base64 without btoa: three bytes in, four chars out. */
export function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[(b0 >> 2) & 63];
    out += B64[((b0 << 4) | (b1 >> 4)) & 63];
    out += i + 1 < bytes.length ? B64[((b1 << 2) | (b2 >> 6)) & 63] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const stripped = s.replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(stripped)) throw new Error("bad base64");
  const out = new Uint8Array(Math.floor((stripped.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (const ch of stripped) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("bad base64");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < out.length) out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

async function deriveKey(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt any JSON-serializable payload into a session blob. */
export async function encryptSession(passphrase: string, payload: unknown): Promise<SessionBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, SESSION_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  return {
    zlSession: 1,
    alg: ALG,
    iter: SESSION_ITERATIONS,
    salt: b64encode(salt),
    iv: b64encode(iv),
    data: b64encode(new Uint8Array(ct)),
  };
}

/** Decrypt and validate a session blob. Throws on wrong passphrase,
    tampering, or anything that is not a Zeolite session blob. */
export async function decryptSession(passphrase: string, blob: unknown): Promise<unknown> {
  if (typeof blob !== "object" || blob === null) throw new Error("not a session blob");
  const b = blob as Partial<SessionBlob>;
  if (b.zlSession !== 1 || b.alg !== ALG || typeof b.iter !== "number" || b.iter < 1 || b.iter > 1_000_000) {
    throw new Error("not a Zeolite session blob");
  }
  if (typeof b.salt !== "string" || typeof b.iv !== "string" || typeof b.data !== "string") {
    throw new Error("malformed session blob");
  }
  const salt = b64decode(b.salt);
  const iv = b64decode(b.iv);
  if (salt.byteLength < 8 || iv.byteLength !== 12) throw new Error("malformed session blob");
  const key = await deriveKey(passphrase, salt, b.iter);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      b64decode(b.data) as unknown as BufferSource,
    );
  } catch {
    throw new Error("wrong passphrase or corrupted blob");
  }
  return JSON.parse(dec.decode(pt));
}
