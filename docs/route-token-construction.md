# The keyed route token construction (#607 analysis)

Decided 2026-11-07. This document is the security analysis of the
v1 keyed route token; the operational posture (what the token protects
and from whom) lives in docs/security.md and issue #606.

## Format

    token = 0x01 || IV(16) || body
    IV    = destMac(key, dest, 1) || destMac(key, dest, 2)
    body  = dest XOR keystream, 8 bytes per block
    keystreamBlock(key, iv, j) = SipHash-2-4(key, iv || u32le(j) || 0x03)

destMac(key, dest, d) is SipHash-2-4(key, dest || 0x0d) with a domain
byte (d = 1, 2 for the IV; 3 for the keystream; 4 for the storage-id
MAC at codec.ts, disjoint from all route-token domains). Decode
recovers dest from body, recomputes destMac(domains 1, 2) and rejects
on mismatch through macEquals, a constant-time 16-byte fold (#203).

## Why this is a synthetic-IV AEAD

The shape is the RFC 5297 (AES-SIV) construction with SipHash-2-4 in
the PRF seat: authenticate first into a synthetic IV, then encrypt
with a keystream derived from that IV. The required properties and
where each comes from:

- Keystream pseudorandomness: each 8-byte block is a fresh PRF
  output over a distinct counter with domain 3, so body bytes are
  one-time-padded under the PRF assumption; no block is ever reused
  across messages because the IV enters every keystream call.
- Tag unforgeability: a forged (IV', body') must decrypt to a dest'
  whose recomputed 128-bit tag (two domain-separated 64-bit PRF
  outputs) equals IV'. Without the key the attacker holds no MAC
  oracle (routes expose no known-plaintext pairs), so per-attempt
  forgery is at the 2^-128 tag bound modulo PRF security.
- Domain separation: domains 1-4 prevent cross-protocol use of PRF
  outputs (route IVs vs keystream vs storage ids).
- Determinism: intentional (#55 route stability). Same key plus same
  destination always mints the same token; this is the source of the
  equality and length leakage documented in docs/security.md (#608).

## Honest limits

- This is not a standardized mode. The analysis above maps it onto
  the SIV shape so a reviewer can check it against a known mode,
  but no independent external cryptanalysis has been performed.
- SipHash-2-4 is the fast variant; its margin rests on key secrecy.
  Per #606 the key is NOT secret against same-origin scripts, so
  token integrity is only ever claimed against parties without the
  key: the browser UI, history and cross-origin observers.
- No nonce, no freshness, no replay protection: routes are bearer
  URLs by design; replay is indistinguishable from navigation.
- Replacement (AES-GCM via WebCrypto) was considered and rejected:
  decode is synchronous on the fetch hot path, WebCrypto is async,
  and the threat model (#606) does not reward the churn. Revisit if
  a deployment requires standardized AEAD or asynchronous decode
  becomes acceptable.
