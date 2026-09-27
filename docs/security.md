# Security audit (2.0 Graphene)

Scope: what was reviewed for this release and what it found. Findings
reference real code seams; nothing here is claimed beyond what the
code does.

## Destination policy (SSF) - one enforcement point

crates/zeolite-server/src/policy.rs is the single place that answers
"may we reach this destination":

- Hostnames are checked before DNS resolution: localhost, .local,
  .internal, .home.arpa and cloud metadata names are blocked.
- Every RESOLVED address is checked again before connect, so a DNS
  rebinding answer that points into private space is rejected after
  a benign first answer.
- Blocked ranges: IPv4 loopback, RFC1918 private, link-local
  (including 169.254.169.254), unspecified, broadcast; IPv6 loopback,
  unique-local fc00::/7, link-local fe80::/10.

Test escape hatch: `ZL_TEST_ALLOW_PRIVATE_DESTS=1` disables the
private-IP block so the nightly fixture origin (127.0.0.1) can be
proxied. It is read only in the policy Default impl, exists solely
for the compat suite, and must never be set in a production process.
Local-name blocking stays on even with the hatch open.

## Header surgery

Two header paths, both deliberate and both in app/src/sw.ts:

- Upstream responses pass stripHostile(), which removes CSP,
  CSP-report-only, X-Frame-Options, HSTS, COOP/COEP/CORP,
  Permissions-Policy, Set-Cookie and Set-Cookie2. This is the core
  tradeoff of an interception engine: the proxied page must run inside
  the embedding application, so the origin's confinement headers cannot
  survive. Consequences, stated honestly:
  - The proxied page's CSP/XFO protections are gone; isolation of the
    proxied page from the host app is the HOST's responsibility (its
    own CSP, iframe sandboxing).
  - Set-Cookie is captured into the per-origin jar before being
    stripped, so the page never sees raw Set-Cookie headers; cookies
    only flow through jar-controlled Cookie headers.
- Engine-initiated requests pass forwardedHeaders(): host, connection,
  referer, origin and cookie from the page are dropped; Referer is
  rebuilt from the real destination; the jar supplies Cookie; a
  fingerprint profile (when active) overrides User-Agent and
  Accept-Language. Header injection through the Headers API is
  structurally prevented by header-name normalization; the hostile
  list is compared lowercase.

## Cookie and storage isolation

- Per-origin jars keyed by the FNV1a36 virtual-origin id; the jar is
  the sole authoritative Cookie source for engine requests. Dotless
  TLD Domain attributes are refused; Max-Age/Expires deletion
  implemented.
- localStorage/sessionStorage/IndexedDB/Cache API are scoped with the
  same id; Cache match only sees the origin's own entries.
- Limits stated in the matrix: SameSite parsed but not enforced (no
  site context exists at the SW seam); Set-Cookie on intermediate
  redirect hops inside the transport is not captured (only the final
  response surfaces).

## Secrets handling

- redactSecrets() runs at the boundary of diagnostics, tracing and
  recording: nothing that stores or transmits log/record data keeps
  credential-shaped values.
- Recording artifacts (zlRecord) never contain cookie values,
  WebSocket payloads, request/response bodies or headers.
- Session export carries secrets only inside AES-256-GCM ciphertext
  (PBKDF2-SHA256, 120k iterations); the passphrase never leaves the
  control message.

## WebSocket

- ws:// targets are upgraded to wss:// before the transport sees
  them; plaintext WS is never dialed (traced as subsystem websocket,
  rule upgrade).
- The bridge registry holds only live connections; zl:teardown closes
  all of them.

## Known open items (honest, not fixed by 2.0)

- SameSite enforcement would need site-for-sites context the SW does
  not have; documented instead of faked.
- CSP of the embedding application is the host's job; Zeolite cannot
  restore the proxied page's own confinement headers and still
  function.
- The compat-suite policy hatch exists; deployments must verify they
  never export ZL_TEST_ALLOW_PRIVATE_DESTS.
- Fingerprinting resistance is spoofing, not anonymity: timing,
  font and other unprofiled surfaces remain measurable.
