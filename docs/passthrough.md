# NativeTransit pass-through invariant (#96)

## Contract

When the transit decision (`app/src/transit.ts`) classifies a request as
NativeTransit, Zeolite transports the browser's request over the wisp
transport and returns the origin's response with the browser's semantics
intact. The invariant, enforced by the browser E2E suite
(`suite/e2e/e2e.mjs`, the `passthrough:` check), is semantic equivalence
with direct browser behavior: the same probe suite runs browser-direct
on a fixture origin and engine-proxied, and the two records must agree.

What the invariant covers, per class:

- HTTP method: forwarded unchanged (`forwardedHeaders` in request.ts).
- Request body: forwarded byte-for-byte.
- Content-Type: forwarded unchanged.
- Other request headers: forwarded except the documented deviations
  below; Range and conditional validators (If-None-Match) pass through,
  so 206/304/416 semantics belong to the origin.
- Cookies: a Set-Cookie on an engine-served response is admitted to the
  per-origin jar, and the next request to that origin carries it. The
  invariant is semantic (the cookie round-trips), not byte-equality of
  the Cookie header (the jar rebuild below).
- Origin semantics: Origin and Sec-Fetch-Site are re-stamped to the
  virtual truth (`origin.ts`) so a same-origin POST still presents the
  page's real origin to its own backend.
- Redirects: the engine resolves the hop chain itself, so the page sees
  the final status and body a direct browser sees after following.
- Response status: preserved, including 206 and 416; a 304 surfaces as
  a marked 200 (documented deviation below).
- Relevant response headers: preserved except the documented deviations.
- Streaming: response bodies are never buffered whole; the bytes arrive
  complete and in order (chunk boundaries are not an invariant - a
  transport may legitimately coalesce).
- Abort/cancellation: aborting a fetch rejects with AbortError exactly
  as direct.

## Documented deviations (explicit, each with its reason)

These are deliberate; the #96 check does not assert them equal.

- Cookie header rebuild: the engine owns the cookie jar (isolation,
  jar profiles, challenge handoff), so the Cookie request header is
  reconstructed from the jar instead of the browser's own store.
- Content-Encoding / Content-Length stripped from responses: the
  transport delivers decoded bodies; a preserved encoding label would
  make fetch() consumers decode plaintext twice.
- Not-modified responses surface as 200: a bare 304 handed to
  respondWith() never settles in Chromium. The browser's own cache
  converts wire 304s into cached 200s by splicing a stored body; a
  service-worker-served 304 has no stored body to splice, so the
  fetch promise hangs forever (the engine's E2E suite hit exactly
  this: the relay completed, the response resolved, the page never
  settled). The engine therefore plays the cache role: a
  revalidation 304 is answered as a synthesized 200 with a null body,
  the preserved validator headers (ETag), and an
  `x-zl-not-modified: 1` marker so consumers can detect the
  conversion. The engine page cache is cache-first and only stores
  fresh 200s, so a revalidation that reaches upstream has no stored
  copy to splice; a null-body 200 is the honest answer.
- Security/isolation headers stripped (CSP, HSTS, X-Frame-Options,
  COOP/COEP/CORP, Permissions-Policy, Clear-Site-Data, NEL/Report-To,
  Set-Cookie on the page view): isolation and privacy are the engine's
  own job; see `HOSTILE` in `app/src/headers.ts` for the full list with
  reasons.
- Destination-bearing informational headers (Link, Content-Location,
  X-Original-URL) stripped, plus Refresh's url= mapped to an engine
  route: functional, not informational, and must not leak plaintext
  destinations.
- Opaque route URLs: the page sees engine routes, not plaintext
  destinations (privacy, #32); response.redirected and Location values
  differ from direct by design.
- Referer re-stamped from the real destination (the engine-origin
  referer would leak the proxy and break origin-sensitive CSRF and
  analytics).
- Sec-Fetch-* re-stamped to the virtual truth (`origin.ts`).
- http -> https upgrade is opt-in (`zl:config`); when enabled the
  destination scheme changes by explicit configuration.
- Hostile-request filtering, rules engine blocks and extension
  webRequest are security filtering, outside the pass-through
  contract by design.

## Enforcement

`node suite/e2e/e2e.mjs` runs the comparison on every push (the
`browser` CI job); a regression in any of the covered classes fails
the build. The probe endpoints live in `suite/e2e/fixtures.mjs`
(`/api/passthrough`, `/api/stream`, `/setcookie2`). As NativeTransit
grows at the expense of RewriteFallback, this suite is the long-term
regression guard for browser compatibility.
