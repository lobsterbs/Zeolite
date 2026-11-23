/* Signature layer (#542): Ed25519 over the canonical manifest text,
   verified only against the first-party signer keys compiled into the
   engine. Fail-closed everywhere: an unavailable WebCrypto Ed25519
   (older runtimes), a malformed signature, or a foreign key all
   verify to null, never throw, and the caller keeps no state. */

import { canonicalManifest } from "./schema";

export interface SignerKey {
  id: string;
  publicHex: string;
}

/* The roots of trust. sample-1 is the sample/test anchor shipped with
   the fixtures; production module distributions get their own
   operator-held pair appended here (rotation is an explicit engine
   change by design, never an automatic one). */
export const SIGNER_KEYS: readonly SignerKey[] = [
  { id: "sample-1", publicHex: "2d3d29b13c777507626bc238e7a38a77c2b243b67ff88f94c91e33f15aa12ded" },
];

export function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = Number.parseInt(hex.slice(i * 2, i * 2 + 1), 16);
    const lo = Number.parseInt(hex.slice(i * 2 + 1, i * 2 + 2), 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Verifies sigHex against the canonical manifest text and returns the
    id of the matching compiled-in signer key, or null on any failure.
    Verifiable with any subset of keys (tests inject throwaway pairs);
    production callers pass SIGNER_KEYS. */
export async function verifyWithKeys(
  keys: readonly SignerKey[],
  canonical: string,
  sigHex: string,
): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return null;
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length !== 64) return null;
  const text = new TextEncoder().encode(canonical);
  for (const key of keys) {
    const raw = hexToBytes(key.publicHex);
    if (!raw || raw.length !== 32) continue;
    try {
      const imported = await subtle.importKey(
        "raw",
        raw as unknown as ArrayBuffer,
        { name: "Ed25519" } as AlgorithmIdentifier,
        false,
        ["verify"],
      );
      const ok = await subtle.verify({ name: "Ed25519" } as AlgorithmIdentifier, imported, sig as unknown as ArrayBuffer, text);
      if (ok) return key.id;
    } catch {
      /* Ed25519 unavailable on this runtime: stay fail-closed. */
    }
  }
  return null;
}

/** Production verification: the canonical manifest text must carry a
    valid signature from one of the compiled-in first-party keys. */
export async function verifyManifest(manifest: unknown, sigHex: string): Promise<string | null> {
  return verifyWithKeys(SIGNER_KEYS, canonicalManifest(manifest), sigHex);
}
