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
- route: required, and "rewrite" is the only accepted value.
- reason: optional short operator explanation.

## What a rule can and cannot do

A matching rule upgrades the default native decision onto the
rewrite path (reason code POLICY_REWRITE, the rule id attached to
the fallback ring entry and the TRANSPORT_FALLBACK event).

It cannot do the opposite. Documents, stylesheets and transformed
scripts REQUIRE rewriting, and native is already the default for
everything else, so a route that demotes a required rewrite or
affirms the default would either break the page or state a
no-op as policy. Validation rejects both with a clear error, and
the engine keeps the defaults.

## Validation and failure behavior

Syntax errors carry the KDL parser's line number. Semantic errors
name the rule: unexpected nodes or properties, duplicate ids,
unknown resource types, non-string match values, anything other
than route "rewrite". A missing file means "no policy". A
malformed file is rejected with a TRANSPORT diagnostics event and
the defaults stay active: routing never changes silently.

## Determinism and testing

compilePolicy and policyMatch are pure functions
(app/src/__tests__/policy.test.ts): parsing, validation,
precedence, matching and the default no-policy behavior are unit
tested without the service worker or any network access.