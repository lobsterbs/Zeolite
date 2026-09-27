# Session export/import (1.7 Sulfide)

A session export is one encrypted blob: the per-origin cookie jars, the
engine's tab list, and any extras the caller supplies. It is a user
session artifact, deliberately separate from engine configuration
(config keys, wisp endpoints, extension registrations never travel in
it), and it contains no plaintext secrets: the payload exists only as
AES-256-GCM ciphertext in the envelope.

## Format

```json
{ "zlSession": 1,
  "alg": "AES-256-GCM/PBKDF2-SHA256",
  "iter": 120000,
  "salt": "<b64>", "iv": "<b64>", "data": "<b64 ciphertext>" }
```

The key is derived from the passphrase with PBKDF2-SHA256 (120,000
iterations) on both export and import and is never stored. The GCM tag
makes tampering detectable: a modified blob fails decryption, it does
not import garbage. Base64 is hand-rolled (`app/src/session.ts`) so no
environment needs `btoa`.

## Control messages

- `zl:exportSession { passphrase, extra? }` ->
  `{ ok, blob }`. The payload is
  `{ version, created, cookies: [...jarSnapshot()], tabs, extra }`,
  encrypted whole. `extra` is caller-supplied data (the host app can
  put its own localStorage dump here; see limits below).
- `zl:importSession { passphrase, blob }` ->
  `{ ok, extra }` on success, `{ ok: false, error }` otherwise.
  Cookie jars are replaced by the blob's jars (validated per record);
  the decrypted `extra` is returned to the caller to apply.

Passphrases must be at least 8 characters; shorter ones are rejected.

## Honest limits

- `localStorage`/`sessionStorage` are invisible to the service worker
  (no localStorage in worker scopes). The host app can export them by
  passing a dump in `extra`; the SW-side engine never fakes having read
  them.
- Site-scoped IndexedDB is same-origin and reachable from the host
  page; it is the host's choice to include it in `extra`. The engine
  exports and restores cookies (its own state) itself.
- Tabs are exported for reference; import does not recreate them. Tab
  state belongs to the host UI, which owns the authoritative list and
  syncs it via `zl:tabs`.
- Import replaces jars wholesale; it does not merge cookie sets.
- A blob is only as strong as its passphrase. There is no recovery.
