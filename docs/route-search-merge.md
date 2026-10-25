# Route-search merge semantics

Engine routes can carry a query twice: a token-encoded destination may
own a query inside the token (JS-literal mints and legacy full-dest
tokens encode the full URL verbatim), and the browser URL may carry a
route search after the token.

The fetch seam (mergeRouteSearch, app/src/request.ts) composes the
upstream destination as a UNION, not a replace:

- A route search whose keys the token query does not carry appends
  byte-exact after it (dest?a=1 + ?b=2 -> dest?a=1&b=2).
- A key conflict resolves with the route-search value winning per key,
  through a canonical URLSearchParams rebuild
  (dest?a=1 + ?a=9 -> dest?a=9).
- A query-free decode keeps plain concatenation (the ordinary #38
  route shape), and an empty token query keeps the search as-is.

Why union: page JS appending a runtime param onto an opaque token
picks ? as the separator precisely because the token hides its own
query. The MSAL live strand (2026-10-25) appended
?iframe-request-id=<uuid> onto an authorize token whose query carried
client_id, redirect_uri and scope; replace semantics sent the
authorize upstream with only iframe-request-id, and AAD answered
AADSTS900144. Union preserves what the upstream needs.

Residual, documented honestly: a page that mints a token from a stale
URL and navigates with a fresh full query no longer drops the stale
keys. Upstreams generally ignore unknown query keys; a live regression
on that shape would need a per-key allowlist decision, not a revert.
