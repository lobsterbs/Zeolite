# First-party engine module system — design (signed modules, typed permissions, stream hooks)

**Status: Design — not implemented.** This document is the dedicated design the
7.0 Erionite roadmap row calls for ("the first-party engine module/plugin surface
formalized from docs/plugins.md (origin-local signed ES modules, typed
permissions, stream hooks)"). Nothing in here ships today; the shipped capability
remains the static build-time registry documented in `docs/plugins.md`. Per the
AGENTS.md status vocabulary this is **Planned**, not Partial.

Related: #542 (this design), #256 (closed, static registry loader), #551
(consumer of a future stream-capable filter module), `docs/power-features.md` §1
(the `LjPlugin` target contract and permission vocabulary).

## 1. Goals and non-goals

Goals:

- Engine-level extensions exist beyond WebExtension compatibility: a
  first-party module can observe request metadata, veto requests, transform
  response streams and receive bounded diagnostics, under typed permissions.
- Every installed module is cryptographically attributed: an invalid signature
  fails closed, before any hook runs.
- Stream hooks preserve backpressure and can never buffer an unbounded body.
- The current static registry stays exactly as it is and remains the safe
  baseline and migration path.

Non-goals:

- No runtime code evaluation of any kind. No `eval`, no `new Function`, no
  fetched-text modules, no loading code from unapproved origins.
- No marketplace or third-party signing in the first iteration. Signers are
  first-party keys controlled by the host distribution.
- No anonymity/anti-detection features and no access to engine secrets (cookie
  jars, upstream credentials, transport internals).

## 2. The runtime constraint that shapes everything

The engine runs inside a Chromium service worker. In that scope:

- dynamic `import()` is unavailable (CI lints `import(<literal>)` out of
  SW-reachable code; this is why #256 shipped a static registry),
- `eval`/`new Function` are unavailable (CSP of the extension origin),
- dedicated workers are not spawnable from the SW for user code.

Therefore "signed ES modules" cannot mean runtime `import()` of signed files.
The honest model is **verified bundle binding**: modules are authored as ES
modules, signed as bundles, and *bound into the service-worker graph at build or
boot by the host*, with the signature verified before the binding is trusted.
What signatures buy here is attribution, integrity and revocation — not late
loading. Late loading inside the SW is impossible and this design does not
pretend otherwise (AGENTS.md: never describe planned behavior as implemented).

## 3. Module format

A module is a bundle of ES module sources plus a canonical manifest:

```jsonc
{
  "id": "im.zeolite.adstrip",          // reverse-DNS, unique, immutable per id
  "version": "1.4.0",                   // semver
  "engine": ">=7.0.0 <8.0.0",           // engine compatibility range
  "permissions": ["observe:requests", "modify:responses"],
  "entry": "./index.js",                // exports register(hooks) exactly once
  "files": { "index.js": "<sha256>" }   // content hashes, canonical key order
}
```

- **Signing**: Ed25519 over the canonical (sorted-key, no-whitespace) manifest
  bytes, with the file hashes binding every source byte. The signature and
  signer key id travel alongside the bundle (`module.sig`).
- **Identity**: the module id is the security principal for permissions,
  quotas, diagnostics and revocation. A re-signed module with the same id is an
  update; a different signer key for the same id is a **conflict that fails
  closed** (no key rotation without an explicit host action).
- **Origin-local storage**: bundles live in host-app storage (the same origin
  that ships the engine). The engine never fetches module bytes from the
  network; updates arrive through the host's own distribution channel and are
  re-verified on arrival and again at boot.

## 4. Trust and lifecycle

1. **Install** (host-driven): verify manifest canonicalization, Ed25519
   signature, engine range and file hashes. Any failure = rejected install,
   bounded `UNSUPPORTED` diagnostic, no state retained.
2. **Boot binding**: for each installed module whose permissions the host has
   granted, verify the signature again (defense against storage tampering),
   then bind the module's statically-registered hooks into the request
   pipeline for the sites that name it (same `plugins` siteconfig wiring the
   static registry uses today).
3. **Revoke** (host-driven, immediate): a revocation list keyed by module id
   and/or signer key. A revoked module's hooks are unbound at the next boot and
   its stored data (see `storage:site`) is quarantined, not deleted — deletion
   is a separate explicit host action.
4. **Failure handling**: a `register()` that throws, a hook that throws, or a
   hook that exceeds its deadline degrades exactly like today's registry path —
   the hook is skipped, one bounded diagnostic per module per failure class per
   boot, other modules unaffected. Never a failed request caused by a module.

## 5. Typed permissions

The permission vocabulary starts from the `docs/power-features.md` §1 set and
adds one capability for stream hooks:

| Permission | Grants | Hard data bounds |
|---|---|---|
| `observe:requests` | read-only request/response metadata | metadata only, no bodies; URLs through `redactSecrets` |
| `block:requests` | veto a request with a reason class | no body access |
| `modify:responses` | rewrite response **bodies** before the rewriter pass | implies stream-hook capability; bounded rewrites (see §6) |
| `storage:site` | per-virtual-site keyed key/value storage | quota per module per site (1 MiB default), no cross-site reads, no engine storage |
| `spoof:configure` | change the fingerprint profile per-site | profile must satisfy `resolveProfile` validation; engine refuses contradictions (#71) |
| `modify:streams` | return a `TransformStream` for a response (implied by `modify:responses`) | backpressure-preserving; quotas in §6 |

Standing rules, unchanged from the power-features contract:

- Modules never receive secrets: no cookie jars, no upstream credentials, no
  `Set-Cookie` values, no transport state. Request `Cookie` headers are visible
  only as "present"/"absent" under `observe:requests`, never by value.
- Permissions are declared in the manifest, displayed by the host at
  install/update, and revocable per module. A missing permission fails closed
  at binding time (the hook is not registered), never at request time.
- `onResponse` **observer** semantics stay exactly what they are today
  (best-effort, never awaited, no body access) and are deliberately separate
  from any stream-transforming hook — an observer can never mutate a response.

## 6. Stream hook contract (`onResponseStream`)

A module returning a `TransformStream` for a response takes on delivery
responsibility for that body. The contract:

- **Backpressure**: the engine pipes the upstream body through the returned
  transform with its natural backpressure; a module that stops reading applies
  TCP-grade backpressure upstream and stalls the page — it may never buffer
  the body internally beyond a declared `bufferBytes` quota (default 1 MiB).
- **Deadlines**: a stream hook has a per-response CPU/wall deadline (default
  5 s of inactivity); expiry = the hook is bypassed (identity passthrough for
  the remaining bytes) + one bounded diagnostic + a strike against the module.
- **Quotas**: bytes transformed per response (cap: the replay/spool budgets),
  concurrent stream hooks per page load (default 4), strikes per boot (3
  strikes = module quarantined until next boot).
- **Ordering**: deterministic — siteconfig `plugins` order, first-declared
  first. A response passes through at most one stream-transforming module per
  response in the first iteration (chaining is a listed open question, §9).
- **Cancellation**: page abort or upstream failure cancels the transform; the
  module's `cancel(reason)` runs with a deadline; leaks (unclosed writable)
  are torn down by the engine and counted as a strike.
- **Delivery-unknown rule**: a module may never replay or duplicate request
  bytes (the #251/#348 transport rules apply unchanged); stream hooks see
  responses only, never request bodies.
- **Diagnostics**: every bypass, strike and quota trip emits one bounded event
  (category `UNSUPPORTED` or `RUNTIME`) naming the module id and the rule
  tripped — never body content.

## 7. Threat model

| Threat | Mitigation |
|---|---|
| Malicious module (ships harmful logic) | first-party signing only; typed permissions; no secrets, no eval surface; host displays permissions at install; revocation list |
| Supply-chain compromise of a signed module's build | signed bundles are immutable and hash-pinned; updates are new signatures, so a compromised build is a *visible* new version, and revocation kills it fleet-wide on next boot |
| Privilege escalation from module to engine | hooks receive frozen context objects; no handle to the engine's transport, cookie jar or IDB; capability boundaries are structural (no APIs exposed that could reach them) |
| Infinite/slow-stream denial of service | backpressure quotas, inactivity deadline, strike/quarantine; the identity-passthrough fallback bounds worst-case damage to "module absent" |
| Cross-site data access via `storage:site` | storage keyed by (module id, virtual site); no API to enumerate other sites; quotas; quarantine on revoke |
| Exfiltration via diagnostics | diagnostics from module paths carry ids and rule names only; `redactSecrets` applies at the diag boundary as everywhere else |

## 8. Migration path

1. **Now (shipped)**: static registry, `docs/plugins.md`. Nothing changes.
2. **First signed modules**: the existing registry entries
   (`sample-observer`) become the first signed bundles — proving the format,
   the install/revoke surface and the diagnostics with zero behavior change.
3. **Stream hooks**: land behind `modify:responses`/`modify:streams` with the
   §6 contract, initially for internal modules only (e.g. a bounded response
   rewriter experiment), before any third-party story is considered.
4. **Host UI**: install/display/revoke is host-owned (the same class as
   notifications and download handoff surfaces); the engine exposes only the
   verification and binding seams plus `zl:*` control messages, and reports
   capability honestly via the #544-style capability reporting.

## 9. Open questions for implementers

- Stream-hook chaining order and composition semantics (§6 allows one per
  response initially).
- Whether `modify:responses` body rewrites should ride the #556 spool when a
  rewrite needs buffering — likely yes, with the same budgets.
- Key rotation UX for signer keys (currently fail-closed by design).
- Whether revocation needs to be effective mid-boot for long-lived streams
  (currently: next boot, with quarantine).

## 10. Acceptance criteria when this is implemented

From #542, unchanged: a signed sample module installs, validates, runs and
revokes without rebuilding the engine bundle (via the host binding seam — the
SW itself still cannot late-load, and the acceptance wording must be read
against §2); invalid signatures, missing permissions and module failures fail
closed with bounded diagnostics; stream hooks preserve backpressure and never
buffer unbounded bodies; the threat model above is test-covered; this document
and `docs/plugins.md` describe the actual shipped capability.
