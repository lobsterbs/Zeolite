# CI browser torture wedge (nondeterministic)

The browser job's torture suite has failed four times on main with a
wedge signature that is NOT a rewriter defect. This note records the
evidence so the next red run can be triaged without re-deriving it.

## Signature

- Several tests pass at the start of the run, then a stretch of
  sequential failures, each "page.goto: Timeout 30000ms exceeded"
  against the same fixture server, each burning the full 30 s.
- The affected categories vary run to run (routing, transport,
  rewriting, isolation); the failures cluster in time, not by
  feature.
- The run partially recovers: later tests pass quickly again.
- Run 41035486199 (head 039c93ac) surfaced the evaluate-timeout
  variant: a single probe died with "torture probe: page evaluate
  timed out" AFTER the harness's one-shot wedge restart had already
  fired and failed again; the goto-timeout variant did not appear at
  all in that run. Same wedge, different probe seam.
- Run 41018448365 additionally surfaced
  SyntaxError: "zeolite: u..." is not valid JSON: an engine error
  string reached code that expected a JSON envelope. That is a
  symptom of the wedge (an error path answering where a response
  was expected), not a rewriting bug.

## Evidence that it is a flake, not a regression

- Run 41018448365 (head e2d5f6c7): red, 6 failures, this exact
  timeout signature. That head changed only the rewriter invariance
  test and the torture harness printing; runtime bytes were
  identical to the previous green run.
- Run on 87cb2c68 (the ASCII-pure correction of the same test): green.
- Run 41033394111 (head 9fc67892): red, 8 failures, same signature.
  The prior heads 87cb2c68 and 9fc67892 differ only by the #511
  WebSocket-over-relay app changes, which the app job typechecks,
  builds and unit-tests green; the wedge fires mid-run on pages the
  ws code never touches.
- Run 41035486199 (head 039c93ac, docs-only on top of 9fc67892;
  runtime bytes identical to the green 87cb2c68 build): red, exactly
  1 failure, the evaluate-timeout variant above. The failed probe
  is "redirect semantics: 301/302/303 rewrite POST to GET, 307/308
  preserve method and body" (transport); the neighboring redirect
  probes passed in the same run: engine-side 302 routing, the 5- and
  15-hop redirect chains, and the NativeTransit redirect marks. The
  redirect logic demonstrably worked around the wedged probe.
- Same runtime bytes red once and green once, twice over: the wedge
  is nondeterministic.

## What has already been ruled out

- The rewriter is exonerated for chunk boundaries:
  torture_doc_chunk_invariance (crates/rewriter) streams the torture
  fixture at every split point and single-char, asserting
  byte-identical output. It is green.
- The srcset pass routes every candidate through enc();
  deterministic, no scheme-relative emission arm exists.
- The torture harness prints the full JSON record on failure
  (torture.mjs), so the next recurrence names the exact assertion
  and the served attribute, not just the URL.

## Operational notes

- The rerun API (rerun_workflow_run / rerun_failed_jobs) is 403 for
  the integration tokens; a new push is the only retrigger. A
  docs-only commit like this one is the cheapest legitimate retry.
- Do not add a blind harness retry: with no named mechanism, a retry
  would only launder the wedge. Fix the wedge when a log names it
  (netLog and the full-record printing exist for exactly that).
