# Hybrid location rewriting (#456)

Status: **Partial**. Per-site policy, bounded AST work and per-instance reason
telemetry are implemented. Legacy behavior remains the deployment default;
this is not a default-off migration or complete location virtualization.

## Configuration

```kdl
site "example.com" {
  location-rewrite "hybrid" max-bytes=524288
}
site "native.example.com" {
  location-rewrite "off"
}
```

The existing longest-host-suffix SiteConfig matching applies. An omitted rule
uses `legacy` (the deployed location-read pass, including event attributes,
with a 2 MiB AST limit). `hybrid` defaults to 512 KiB and excludes event
attributes. `off` disables only location rewriting; URL literal rewriting and
frame-buster handling continue. An explicit positive integer cap up to 2 MiB
is supported; invalid modes/caps leave the legacy configuration unchanged.
No hosts are automatically opted in. A generic application 404 does not prove
a location-read failure and cannot safely trigger rewriting.

Inline executable script bodies and external scripts use the same policy.
External scripts resolve URL literals against their own resource URL, but
choose location policy using the verified initiating page, including on cache
hits. Unknown initiators retain legacy behavior rather than guessing a CDN's
policy. Workers and eval are outside this rollout.

## Processing and diagnostics

A token pre-scan avoids parsing irrelevant bodies. The AST pass skips bodies
over the configured UTF-8 byte cap and returns its input unchanged on parse
failure. Assignment/update/delete target spans remain native; shadowed locals
remain untouched. This cap bounds AST work, **not total response buffering**:
the pre-existing URL-literal/HTML raw-script paths can still retain larger
bodies. Streaming candidate passthrough needs a separate pipeline change.

Each rewriter retains at most 32 pending reason records; the service worker
drains those into the existing bounded diagnostic ring. Reasons distinguish
`disabled`, `no-candidate`, `size-cap`, `parse-failure`, `no-reads` and
`rewritten`. Messages contain only fixed reason names and counts, never source
code or sensitive URLs. They are observations, not proof of site compatibility.
The additive WASM methods keep the previous external export ABI available.
A stale WASM lacking policy support emits an unsupported warning; an external
script with an explicit non-legacy policy passes through unchanged. Deploy the
service worker and generated WASM together; stale inline rewriters cannot
apply these controls.

## Remaining rollout gates

- Decide the default-off migration without regressing existing deployments.
- Bound total candidate buffering across the other rewrite passes.
- Add direct/proxied Chromium fixtures and scoreboard evidence before enabling
  policies for reported failing sites.
- Keep dynamic eval, worker source, computed properties, shorthand bindings,
  and browser-owned location surfaces explicitly unsupported where applicable.

A real Chromium fixture (`suite/e2e/location-policy.mjs`) checks the generated
WASM and execution of direct versus rewritten location reads. The existing
browser CI job gates it. Full proxied live-site rollout remains unverified.

Tests cover policy validation, CDN/page ownership, inline/external wiring,
read/write AST safety, cap skips, parser failure and bounded telemetry. These
checks do not replace the outstanding browser compatibility gate.
