# Compatibility policy (issues #135, #136)

The transit decision layer (app/src/transit.ts) classifies every
intercepted request: NativeTransit by default, RewriteFallback where
the engine requires rewriting (documents, stylesheets, transformed
scripts), Blocked at the deny gates. Every decision carries a
stable reason code and lands in the fallback ring and the
TRANSPORT_FALLBACK diagnostics.

The policy layer (app/src/policy.ts) adds the one compatibility
lever classification alone cannot express: a declarative KDL rule
that upgrades specific requests onto the rewrite path when a real
site incompatibility requires it.

## Grammar

The file is /policy.kdl at the engine origin (fetched once per
worker lifetime, like /rules.kdl):

```kdl
rule "broken-literals" priority=10 {
  match host="cdn.example.com" path="/assets/"
  types "script" "fetch"
  route "rewrite"
  reason "absolute URL literals break under native transit"
}
```

Fields:

- rule id (first string argument): required, unique, rides the
  transit decision and the diagnostics.
- priority (number property): optional, default 0. Higher wins;
  on equal priority the later rule in document order wins.
- match host: exact hostname or any parent domain (the same
  grammar as the rules host lists). Optional.
- match path: URL pathname prefix. Optional.
- types: zero or more resource types from the rules vocabulary
  (document, script, style, image, font, media, websocket, worker,
  manifest, eventsource, wasm, fetch, other). Optional; absent
  means all types.
- route: required. "rewrite" upgrades matching requests onto the
  rewrite path; "native" (#138) demotes the JS literal pass for
  proven hosts; "relay" (#137) moves the fetch onto the embedder's
  network stack for TLS-fingerprint-blocked hosts; "wisp" (#168)
  rides the engine's own wisp transport through the public wisp
  endpoint the embedder announces.
- reason: optional short operator explanation.

## What a rule can and cannot do

route "rewrite" upgrades the default native decision onto the
rewrite path (reason code POLICY_REWRITE, the rule id attached to
the fallback ring entry and the TRANSPORT_FALLBACK event).

route "native" (#138) demotes the JS literal pass for a host
proven to work with raw script bodies: runtime navigation already
flows through the patched fetch/XHR/WS seams, so literal hits
there are dead code. Documents and stylesheets are never demoted,
and the demotion records a POLICY_NATIVE transit decision with the
rule id so the native share stays honest in telemetry.

Behavior routes compose with transport routes (#154): the transport
selection (upstreamFetch) ignores behavior rules, so a "native"
host rule rides the transport a relay/wisp rule would pick for the
request (a match-less relay rule still carries it) instead of
dropping its requests onto the default wisp transport. The behavior
side (the literal pass demotion) still uses the full rule set.

route "relay" (#137) moves matching fetches onto the embedder's
network stack (native TLS, embedder-side SSRF validation) for
hosts that reject the wasm TLS ClientHello shapes at the
handshake. The embedder must have registered a relay channel
(zl:relayRegister); without it the fetch falls back to wisp with a
TRANSPORT warning, and the decision is recorded (result "relay")
so diagnostics keep the share honest.

route "wisp" (#168) rides the engine's own wisp transport (the
libcurl-wasm ClientHello) through a PUBLIC unauthenticated wisp
endpoint the embedder announces (zl:wispRegister). The
brave-search class refuses the relay transport but accepts the
wasm ClientHello - the inverse of the #149 Akamai set, and no
single transport satisfies both sets. Without an announced
endpoint the fetch rides the default path with a TRANSPORT
warning. Honest limits: the route is only as good as the public
endpoint's egress (LB shares that endpoint with the ScramJet
engine option), only the libcurl engine carries it, and there is
no proactive reconnect watcher for the secondary socket (a failed
fetch resets the secondary client, retries once, then falls back
to the default path).

Documents, stylesheets and transformed scripts REQUIRE rewriting,
so no route demotes those passes; a route value outside the four
above is rejected with a clear error and the engine keeps the
defaults.

## Validation and failure behavior

Syntax errors carry the KDL parser's line number. Semantic errors
name the rule: unexpected nodes or properties, duplicate ids,
unknown resource types, non-string match values, an unknown
route value. A missing file means "no policy". A
malformed file is rejected with a TRANSPORT diagnostics event and
the defaults stay active: routing never changes silently.

## Determinism and testing

compilePolicy and policyMatch are pure functions
(app/src/__tests__/policy.test.ts): parsing, validation,
precedence, matching and the default no-policy behavior are unit
tested without the service worker or any network access.