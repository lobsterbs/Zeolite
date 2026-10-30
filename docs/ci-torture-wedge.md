# CI browser torture cascade (intermittent transport death)

Correction of the record (2026-10-30): the first red runs were triaged
as a position-random runner wedge. That was wrong. In every red run
the SAME probe fails first and the cascade follows. The trigger is
deterministic; only its firing is intermittent. Tracked in #514.

## The trigger

- The first failure is always the transport probe "redirect
  semantics: 301/302/303 rewrite POST to GET, 307/308 preserve
  method and body" (five body-preserving POST redirects against a
  direct oracle, suite/e2e/torture.mjs).
- Runs 41018448365, 41033394111, 41036816363: frame.evaluate fails
  with SyntaxError: Unexpected token 'z', "zeolite: u"... is not
  valid JSON. That string is the SW fetch failure response
  "zeolite: upstream fetch failed: ..." (app/src/request.ts): the
  probe's engine-side fetch died upstream and the error text reached
  JSON.parse.
- Run 41035486199: the stall variant of the same probe ("page
  evaluate timed out"); everything else in that run passed.
- The harness wedge restart (engine + browser context) fires in all
  four runs; the retest fails again each time, and the suite then
  sees fast error responses or 30 s first-byte-deadline stalls
  (page.goto timeout cascade, partial or no recovery).

## Why the #511 wave is exonerated

- Run 41018448365 (head e2d5f6c7) carries PRE-#511 runtime bytes
  (identical to the pin 137 build and to the green 87cb2c68 build)
  and fails the same probe the same way. No torture probe touches
  page WebSockets.
- The green 87cb2c68 run started six minutes after the red e2d5f6c7
  run, in the same runner pool with the same pinned Chromium: the
  trigger is intermittent, not environmental determinism.

## What has already been ruled out

- The rewriter is exonerated for chunk boundaries:
  torture_doc_chunk_invariance (crates/rewriter) streams the torture
  fixture at every split point and single-char, asserting
  byte-identical output. It is green.
- The srcset pass routes every candidate through enc();
  deterministic, no scheme-relative emission arm exists.
- The torture harness prints the full JSON record on failure
  (torture.mjs).

## Operational notes

- The rerun API (rerun_workflow_run / rerun_failed_jobs) is 403 for
  the integration tokens; a new push is the only retrigger. A
  docs-only commit like this one is the cheapest legitimate retry.
- Pinning a dist whose browser job failed is acceptable ONLY with
  the diagnosis above on record (see the pin 135 precedent); the app
  job (which builds the bundle) is green in every affected run.
- Do not add a blind harness retry beyond the existing one-shot wedge
  restart: the retest already fires and fails; the fix belongs in
  the transport seam (see #514).

## Fifth occurrence: the 307-settle variant (2026-10-30, run 41134928744)

- Run 41134928744 (head 4fd5870b, the #557/#548/#555 storage wave plus
  the #543 fragment wave): the per-code outcomes added in 648e6e5 name
  the failing code for the first time. The proxied 307 redirect fetch
  never settles ("Timeout 8000ms exceeded (fetch never settled)");
  301/302/303 settled before it and 308 was never reached.
- The in-harness wedge restart fired and the retest failed the same
  way; the engine log tail shows an upstream relay stream that opened
  and never closed. No cascade this time: every later probe, including
  the redirect-chain probe, passed, and browser is the run's only red
  job (rust/wasm/app/compat green; the app job published the dist
  bundle normally).
- The storage/fragment waves are exonerated the same way #511 was:
  run 41132923104 (head 9da7e236, the Vary metadata, page-cache bound
  and databases() view code in) is browser-green on this exact probe,
  and run 41038517509 (head 7cbac22f, docs-only) is red on the same
  probe with none of this code in. The 307 body-replay-per-hop seam is
  untouched by both waves.
- This docs-only commit is the recorded bounded retrigger; if the
  browser job greens, the wedge stands as the sole cause of the red.
