# Hybrid location rewriting (#456)

Status: **Partial**. Per-site policy, bounded AST work, the shared streaming cap, per-instance
reason telemetry and gate 4 (corroborated automatic targeting) are
implemented.
Legacy behavior remains the deployment default; this is not a default-off
migration or complete location virtualization.

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
An explicit rule always wins over the learned mark below, including `off`.

## Automatic targeting (gate 4)

A pathname-reading SPA that answers a correct URL with its own not-found
view (the play2048.co class, the LegacyUnforgeable limit) is marked for the
hybrid pass on its next load. The mark requires corroborated evidence, never
a generic 404 (a legitimate application response):

- a bounded page-side watcher, injected with the document init script, fires
  only on a strong marker (the document title or the first h1/h2 reads
  "404" / "not found") and reports through the `zl:spa404` control message
  carrying no data;
- the worker recovers the origin from the sender's own route (never a
  page claim) and requires reports from at least 2 distinct loads;
- the origin's documents must have shown actual location-read rewrites
  (the wasm pass reason `rewritten`) - reads without reports and reports
  without reads both stay legacy.

The store is hostname + counters only, bounded (512 origins), 7-day TTL,
cleared on worker restart. The feature is on by default per the issue's
hybrid design: a false positive opts an origin into the bounded, fail-open
pass (strictly closer to native behavior), a mark emits a REWRITE diag
event, and `zl:config locationTargeting false` is the host kill switch.
The learned snapshot rides the `zl:getNetLog` stats view
(`stats.locationTarget`).

Inline executable script bodies and external scripts use the same policy.
External scripts resolve URL literals against their own resource URL, but
choose location policy using the verified initiating page, including on cache
hits and for the learned mark. Unknown initiators retain legacy behavior
rather than guessing a CDN's policy. Workers and eval are outside this
rollout.

## Processing and diagnostics

A token pre-scan avoids parsing irrelevant bodies. The AST pass skips bodies
over the configured UTF-8 byte cap and returns its input unchanged on parse
failure. Assignment/update/delete target spans remain native; shadowed locals
remain untouched. This cap bounds AST work. Total candidate buffering is bounded across
all passes by one shared streaming cap: a script or worker body whose
candidate content exceeds 2 MiB is served verbatim, fail-open (the wasm
HTML pass emits an over-cap raw script unchanged; the worker-prelude,
worker-body and script serve seams stream the remainder through without
rewriting, annotate netlog as `js-body-cap` and emit a `RAW_BODY_CAP`
diagnostic stage). Under the cap every pass rewrites as before.

Each rewriter retains at most 32 pending reason records (newer events past
the bound are dropped, not queued); the service worker
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

- The default-off migration question is decided: automatic targeting stays
  on by default (operator decision). No default-off migration is planned for
  existing deployments.
- Total candidate buffering is bounded (the shared streaming cap above); no
  rewrite pass retains an unbounded body.
- Scoreboard evidence exists at engine level (real Chromium probe in
  `suite/e2e/location-targeting.mjs`: corroborated mark, scoreboard stats,
  hybrid flip, hostname scoping and the kill switch) and at live-corpus
  level: the report-only probe `suite/e2e/location-targeting-live.mjs`
  (browser CI job) loads the shipped play2048.co rule site plus deep routes
  and writes `suite/location-targeting.json`, uploaded as a run artifact.
  The first live run corroborated the heuristic: a GitHub Pages own-404
  deep route auto-marked from two distinct clients with recorded location
  reads, while a reads-only embedded origin stayed unmarked. Continuous
  runs accumulate the migration evidence.
- Keep dynamic eval, computed properties, shorthand bindings, and
  browser-owned location surfaces explicitly unsupported where applicable.
  Worker bodies are not in this loss class: under the cap they pass the
  same rewrite seam at serve time with the owner page policy; over the cap
  they are served native. Eval and blob workers stay unsupported per the
  issue's accepted losses: regex rewriting is banned and no page-realm
  seam exists for eval.

A real Chromium fixture (`suite/e2e/location-policy.mjs`) checks the generated
WASM and execution of direct versus rewritten location reads; a second
engine-level probe (`suite/e2e/location-targeting.mjs`) drives the corroborated
auto-mark end to end, and a report-only live-corpus probe
(`suite/e2e/location-targeting-live.mjs`) measures the heuristic on external
sites; it never gates CI and writes `suite/location-targeting.json`.
The existing browser CI job runs all three. Full proxied
live-site rollout remains unverified.

Tests cover policy validation, CDN/page ownership, inline/external wiring,
read/write AST safety, cap skips, parser failure and bounded telemetry. These
checks do not replace the outstanding browser compatibility gate.
