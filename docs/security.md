# Security audit (3.0 Diamond re-audit)

Scope: the 2.0 Graphene audit re-run at 3.0 against the surface added
since, plus corrections of findings the 2.0 text listed as open but
2.x has since closed. Findings reference real code seams; nothing is
claimed beyond what the code does.

## Destination policy (SSRF) - one enforcement point

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

Re-audited at 3.0: unchanged, still the only gate. The engine has
exactly one dial path (the policy-gated wisp hop); nothing added
since 2.0 dials a destination outside it.

## Header surgery

Two header paths, both deliberate and both in app/src/sw.ts:

- Upstream responses pass stripHostile(), which removes CSP,
  CSP-report-only, X-Frame-Options, HSTS, COOP/COEP/CORP,
  Permissions-Policy, Set-Cookie and Set-Cookie2. This is the core
  tradeoff of an interception engine: the proxied page must run inside
  the embedding application, so the origin's confinement headers
  cannot survive. Consequences, stated honestly:
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

Re-audited at 3.0: the engine-route CORS surgery (2.3, app/src/cors.ts)
never reflects a request origin: engine routes state the engine's
own CORS facts, credentialed responses get the engine origin, and
arbitrary cross-origin consumers fail closed. The engine error page
(2.3) is generated from the engine's own fixed markup, never from
upstream bytes.

## Cookie and storage isolation

- Per-origin jars keyed by the FNV1a36 virtual-origin id; the jar is
  the sole authoritative Cookie source for engine requests. Dotless
  TLD Domain attributes are refused; Max-Age/Expires deletion
  implemented.
- localStorage/sessionStorage/IndexedDB/Cache API are scoped with the
  same id; Cache match only sees the origin's own entries.
- 2.0 audit correction (closed in 2.2): Set-Cookie on intermediate
  redirect hops IS captured. The SW follows the hop chain itself (the
  transport surfaces 3xx) and applySetCookie runs against every hop;
  a hop the SW cannot follow (307/308 with a stream body, the 10-hop
  cap) still surfaces with its Location mapped to an engine route,
  and its own Set-Cookie was captured first.
- 2.0 audit correction (closed in 2.2): SameSite is enforced through
  the opt-in zl:sameSite knob ("off" | "approx"), using approximate
  site context recovered from the request referrer. It stays off by
  default, honestly, because the SW seam has no true site context.
- Merge-mode session import (2.2) takes per-cookie conflict rules and
  writes only through the same jar path; it introduces no new
  cookie source.

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
- Re-audited at 3.0: the SharedWorker bridge (2.3) rides the same
  relay rule (the engine is the relay parent, a page never becomes
  one) and the same ws->wss upgrade.

## Known open items (honest, not fixed by 3.0)

- SameSite approximation quality: referrer-derived site context is
  approximate for engine-initiated subresource requests; the knob
  stays opt-in.
- CSP of the embedding application is the host's job; Zeolite cannot
  restore the proxied page's own confinement headers and still
  function.
- The compat-suite policy hatch exists; deployments must verify they
  never export ZL_TEST_ALLOW_PRIVATE_DESTS.
- Fingerprinting resistance is spoofing, not anonymity: timing,
  font and other unprofiled surfaces remain measurable.
- The vendored transport's craigslist behavior (issue #11) is not a
  security issue: no data leaks, the failure is closed (error page),
  and the target host is unaffected.
