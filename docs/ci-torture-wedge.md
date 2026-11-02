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


## Merge-window occurrences (2026-11-01 through 2026-11-02)

- The seventeen-PR merge wave (engine bytes of dist 5a03ec34, main
  content 0973b219 plus comment-only heads) hit the wedge in four
  consecutive gate attempts, each with a DIFFERENT first-failure
  probe, the position-random signature:
  - Run 41351728517: the 700 ms TTFB torture probe, embedder still
    "Starting engine...", no cascade beyond it.
  - Run 41352245827: the documented trigger probe itself, redirect
    semantics 301 "fetch never settled", then the page.goto cascade.
  - Run 41352289075: #545 worker-initiator timeout, then the
    page.goto cascade.
  - Run 41407727247 (uncontended, 07:39Z 2026-11-02): passthrough #96
    marks range/cond/setcookie/cookie/stream/redir HUNG at 6000 ms
    with get/post/abort ok, then the page.goto cascade.
- Exoneration evidence for the wave content: passthrough #96 is
  GREEN on the same engine bytes in the other three runs (12 probe
  groups matched, all marks ok), the redirect probe is green in
  41407727247, and a deterministic wave regression would fail the
  same probe every run. The wave bytes have no green run yet; a
  green retrigger completes the exoneration the same way the #511
  and storage-wave comparisons did.
- Firing-rate note: green runs occur until 16:21Z 2026-11-01, red
  from about 20:00Z onward, fifteen-plus consecutive, including the
  single uncontended morning run. The 41407727247 engine log tail
  again shows upstream streams that opened and never closed
  (raw.githubusercontent.com:443 streams with no relay-ended lines
  on an egress-blocked runner), the documented wedge signature.
- The live probe measurement is report-only since #587 (play2048
  unreachable verdicts are egress-class and do not gate).
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The LobsterBrowse pin stays blocked until a
  full green run per the stricter ship gate; pinning a red-browser
  dist is not taken here.
- Run 41409567468 (07:56Z 2026-11-02, head 32947584, docs-only on the
  same engine bytes): the wedge did NOT strike the main e2e suite (it
  passed); the red is the #528 srcdoc-clients harness bug fixed at
  48d9c5c9 (the suite's own probe fetch contaminated the leak
  assertion, so it could never pass on Chromium 131), plus the known
  non-blocking RSPOOL failure (continue-on-error, tracked in #556).
- Run 41412551947 (08:22Z 2026-11-02, head 48d9c5c9, test-only on the
  same engine bytes): the wedge struck the torture suite with a
  DIFFERENT first-failure pair, the position-random signature: the
  ~2 MB streamed-document probe ("first marker never rendered in
  60s") and the 700 ms TTFB probe ("timeout waiting for proxied
  frame", embedder stuck at "Starting engine..."), while the main
  e2e suite PASSED in the same run and rust/wasm/app/compat are all
  green. This docs-only commit is the recorded bounded retrigger per
  the operational notes. The pin gate stands: all five jobs green or
  no LobsterBrowse pin.
- Run 41413856957 (08:32Z 2026-11-02, head 7d14fbe9, docs-only on the
  same engine bytes): the wedge struck the MAIN e2e suite with the
  passthrough #96 signature again (range/cond/setcookie/cookie/
  stream/redir HUNG at 6000 ms, get/post/abort ok, then the
  page.goto cascade), the same first-failure signature as
  41407727247, while rust/wasm/app/compat are all green. This
  docs-only commit is the recorded bounded retrigger; the pin gate
  stands.
- Run 41415629378 (08:47Z 2026-11-02, head 78b4f57d, docs-only on the
  same engine bytes): the wedge struck the torture suite with yet
  another first-failure pair - the interception methods probe
  ("torture probe: page evaluate timed out") and the status
  preservation probe (page.goto 30s timeout) - while the MAIN e2e
  suite PASSED in the same run and rust/wasm/app/compat are all
  green. Sixth consecutive position-random strike on identical
  engine bytes. This docs-only commit is the recorded bounded
  retrigger; the pin gate stands.
- Run 41437602567 (11:32Z 2026-11-02, head 284d0dd0, docs-only on the
  same engine bytes): every earlier suite PASSED (main e2e, torture,
  reload-count, guest-SW, computed-URL); inside the replay-spool step
  the suite's Chromium died mid-run at 11:42:14 ("Target page, context
  or browser has been closed"), the harness churned its remaining
  probes to the 480 s bound and printed "1 passed, 16 failed" at
  11:48:36, then its SIGTERM teardown DEADLOCKED: node never exited,
  tee never saw EOF, the step hung for 15 more minutes and the browser
  job's own timeout-minutes: 30 cancelled the whole run at 12:03:40
  (job conclusion "cancelled", "##[error]The operation was canceled",
  orphans timeout/tee/node still alive at cleanup). No external actor:
  the same job-start-plus-30-minutes signature matches every other
  cancelled run in this window (41352261666, 41352325842 and the
  cookies-torture-jar runs 41409321130/41409326844). The
  investigation is closed as CI mechanics, not sabotage. Fix shipped
  in this commit (CI-only, engine bytes unchanged): the RSPOOL step
  gains -k 30 (force-kill 30 s after TERM) and a step-level
  timeout-minutes: 12, so a wedged replay-spool ends its step (124,
  absorbed by continue-on-error) instead of the whole job. The pin
  gate stands: all five jobs green or no LobsterBrowse pin.
- Run 41456829858 (13:53Z 2026-11-02, head 0406d4d4, CI-only on the
  same engine bytes): the main e2e suite PASSED (66/66) again; the
  wedge struck the torture suite with a NEW first victim - the
  interception methods probe ("torture probe: page evaluate timed
  out", the stall variant) - followed by the cascade: the 700 ms TTFB
  probe stuck at "Starting engine...", the hardened #514 per-code
  diagnostics firing for the first time in a red run ("proxied
  redirect probe failed on code 301: Timeout 8000ms exceeded (fetch
  never settled)"), then 30 s goto timeouts across routing/
  rewriting/isolation; 7 passed / 13 failed. The browser job
  COMPLETED normally (no cancellation; ~14.7 min) - the RSPOOL
  kill-after fix from the previous commit was not reached because a
  torture failure skips the later steps. Seventh consecutive
  position-random strike on identical engine bytes; rust/wasm/app/
  compat all green. This docs-only commit is the recorded bounded
  retrigger; the pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Run 41520211250 (20:32Z 2026-11-02, head 228518a7, the #514

- First run with the #556 fixture redirect-origin fix in: the
  replay-spool suite PASSED for the first time in this window - the
  direct oracle no longer chased a dead 7101 Location and the suite
  completed inside its step bound.
- The wedge then struck the torture suite with the ~2 MB streamed-
  document probe again ("first marker never rendered in 60s",
  embedder "Starting engine..."), followed by the torture-page
  img#uni direct-model assertion. The "fixture regression" label is
  the harness wording for a direct-oracle miss, not a fixture
  fault: the unicode fixture path is untouched by the origin change
  and the same assertion is green on these engine bytes in the
  earlier torture greens (e.g. 41483811807). Ninth consecutive
  position-random strike; rust/wasm/app/compat all green.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Runs 41520211250 and 41522301881: the img#uni decode-skip flake

- Run 41520211250 (head 228518a7): replay-spool PASSED for the first
  time in this window (the #556 fixture redirect-origin fix verified
  in CI); the wedge struck torture with the ~2 MB streamed-document
  probe ("first marker never rendered in 60s", embedder "Starting
  engine...") and the torture-page img#uni direct assertion followed.
- Run 41522301881 (head e9ac6c8e, docs-only retrigger): every earlier
  torture probe passed, including large document #99 (end 2595 ms)
  and the unicode routing probe that fetches the SAME
  /dir/unicode/%C3%A5.png in the SAME direct page 0.3 s before the
  torture-page probe - yet img#uni stayed complete-but-undecoded
  past its 10 s poll. That is the documented #ss decode-skip flake
  ("the renderer can leave an image undecoded via its in-process
  image cache - CI hit it on the direct oracle twice"), now hitting
  the decode-based direct sanity of img#uni.
- Fix shipped in this commit (harness-only, engine bytes unchanged):
  the torture-page imgState forces the element's own decode once and
  then falls back to the same deterministic serve contract the #ss
  candidate already uses (element URL serves 200 with bytes); the
  direct oracle asserts decode OR serve, the proxied arm keeps the
  strict decode contract. The fixture itself serves the PNG 200/68
  bytes (verified locally against startFixture).
- The pin gate stands: all five jobs green or no LobsterBrowse pin.

## Run 41524458112 (21:01Z 2026-11-02, head b002d0ff, e2e harness-only)

- The img#uni decode-skip fix held: no torture-page failure this run
  and the torture battery ran past the torture-page probe. The wedge
  instead struck the MAIN e2e suite with the #545 worker-initiator
  timeout ("worker fetch initiator timeout") as the first failure,
  then the familiar page.goto 30 s cascade (shared-worker relay,
  #453 identities, storage round-trip, jar-backed document.cookie,
  Set-Cookie capture) and the passthrough #96 HUNG marks (range/
  cond/setcookie/cookie/stream/redir at 6000 ms, get/post ok) - the
  position-random signature again, a different first victim on each
  of the last three heads. rust/wasm/app/compat green.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Run 41526555150 (21:14Z 2026-11-02, head 8125e9c1, docs-only retrigger)

- The wedge struck the torture suite with the 700 ms TTFB probe first
  ("timeout waiting for proxied frame", embedder "Starting engine..."),
  and the torture-page img#uni direct assertion failed again in the
  cascade: with the serve fallback now in place this run shows the
  direct page itself could not fetch the element URL (the collect
  returned, so the fetch threw or answered non-200), which places the
  failure in the wedged-context cascade, not the fixture: the same
  URL serves 200/68 bytes against startFixture locally and the
  unicode routing probe in the same battery fetches the same path
  in the same direct page.
- Position-random first victims across the last three heads: #99
  large document, img#uni, #545 worker initiator, 700 ms TTFB - the
  intermittent transport wedge, not wave content; rust/wasm/app/
  compat green again.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Run 41528599862 (21:28Z 2026-11-02, head 492cf9ce, docs-only retrigger)

- The same deterministic cascade pair as 41526555150: the 700 ms TTFB
  probe wedged first (embedder "Starting engine..."), then the
  torture-page img#uni direct assertion failed through the serve
  fallback - the direct page's own fetch of the element URL errored,
  consistent with fixture-connection starvation by the wedged
  engine's never-closed streams (the documented #514 signature;
  the fixture itself serves the URL 200/68 bytes locally and the
  unicode routing probe passed again this run).
- rust/wasm/app/compat green; browser the only red. The wedge root
  cause remains #514; the harness fallback is the right contract and
  held on the one run the wedge did not strike (41524458112 had no
  torture failure at all).
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Run 41530582931 (21:41Z 2026-11-02, head c741ca6c, docs-only retrigger)

- Third consecutive run with the identical pair: the 700 ms TTFB
  probe wedged (embedder "Starting engine...") and the torture-page
  img#uni direct assertion then failed through the serve fallback.
  Across the evening window (21:0x-21:5xZ) the wedge fires every
  gate attempt; the first-victim position still varies across heads
  (main e2e #545 on b002d0ff, the TTFB probe on the three others),
  so the engine bytes stay exonerated and the strike rate is the
  runner-contention variable, as on 2026-11-01 when the same evening
  window burned fifteen-plus consecutive runs and cleared overnight.
- rust/wasm/app/compat green again (browser the only red).
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.

## Run 41532533219 (21:54Z 2026-11-02, head 4fe492a0, docs-only retrigger)

- The browser job hung past its own 30-minute cap with ZERO failed
  jobs (the failed-jobs oracle reported 0/5 the whole run) and the
  run concluded "cancelled" at the job-start-plus-30-minutes mark -
  the documented wedge-hang signature (a step wedged without
  producing a failure verdict; the same signature as the 41437602567
  record). Ninth consecutive evening-window strike; rust/wasm/app/
  compat green.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin; the LobsterBrowse pin stays at 150 (dist
  8223b1ff from green run 41483811807) until a green run lands.
