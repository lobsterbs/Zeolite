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

## Run 41537416248 (22:31Z 2026-11-02, head 5b13c5dc, docs-only retrigger)

- Browser job red again (tenth consecutive evening strike; see the
  entries above for the position-random signatures). rust/wasm/app/
  compat green. Same engine bytes, same first-victim rotation.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes, queued into the overnight window where the
  2026-11-01 contention cleared. The pin gate stands: all five jobs
  green or no LobsterBrowse pin. Pin 150 (dist 8223b1ff, green run
  41483811807) remains the deployed pin on all three LB services.


## Run 41603234425 (08:24Z 2026-11-03, head c3268850, app-TS engine change)

- Browser job red with the passthrough #96 signature: after the cookie
  jar and cookieStore facade probes all PASSED, the NativeTransit
  passthrough suite hung (range/cond/setcookie/cookie/stream/redir
  HUNG at 6000 ms, get/post/abort ok) and the page.goto cascade
  followed; rust/wasm/app/compat are all green. Eleventh strike, now
  in the morning window.
- The head is the first engine-bytes change since pin 150's wave
  (app TS only: the download registry DoubleClick f.txt ad artefact
  filter, isAdArtefact, with unit tests; no crates touched). The
  failing suite exercises none of it; the same wedge struck six
  docs-only heads on identical engine bytes on 2026-11-02.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin. Pin 150 (dist 8223b1ff, green run 41483811807)
  remains the deployed pin on all three LB services.


## Run 41604559271 (08:36Z 2026-11-03, head 7e7b044, docs-only retrigger)

- The wedge rotated victims again: the MAIN e2e suite PASSED this run
  and the browser red moved to the torture suite step; rust/wasm/
  compat green.
- NEW: the app job also flaked this run - ws-shim.test.ts "rejects
  SAB-backed views" failed with "TypeError: WebAssembly response
  has unsupported MIME type 'text/javascript'" - a MIME mismatch in
  a wasm-mocking test unrelated to the head: the app job was green
  on the parent head c3268850 (run 41603234425), and the full app
  suite (256 files, 2784 tests) is green on the same tree locally
  in a clean worktree. Recorded as the first observed app-job strike
  of this wedge family.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin. Pin 150 (dist 8223b1ff, green run 41483811807)
  remains the deployed pin on all three LB services.



## Run 41606184413 (08:49Z 2026-11-03, head 66807c00, docs-only retrigger)

- The wedge struck the torture suite only: 19 of 20 torture probes
  passed and the single red is the torture-page probe's img#uni
  assertion on the DIRECT-oracle arm ("direct model failed to load
  img#uni (fixture regression)", the harness's own wording for a
  direct-oracle miss) - the same decode-skip flake family as
  41520211250/41522301881, failing here through the b002d0ff
  decode-or-serve contract. The failing arm does not traverse the
  engine and exercises none of the head's app-TS change; the MAIN
  e2e suite PASSED in the same run; rust/wasm/app/compat green; the
  app job published dist 08fd43cd normally.
- The app-job ws-shim flake of run 41604559271 did NOT recur (app
  green this run), completing its record as a one-off.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. The pin gate stands: all five jobs green or no
  LobsterBrowse pin. Pin 150 (dist 8223b1ff, green run 41483811807)
  remains the deployed pin on all three LB services.


## Run 41607524709 (09:00Z 2026-11-03, head 50bae0da, docs-only retrigger)

- Fourth consecutive strike today, rotating back to the MAIN e2e
  suite: the #545 worker-initiator timeout first ("worker fetch
  initiator timeout"), then the standard page.goto 30 s cascade
  (shared-worker relay, #453 identities, storage round-trip, jar
  document.cookie, Set-Cookie capture, cookieStore facade), 58
  passed / 8 failed; rust/wasm/app/compat green; the app job
  published dist normally again. The torture suite was never
  reached (main-suite red skips it).
- Exoneration across the four strikes of this wave is now complete:
  on identical engine bytes the main e2e suite PASSED in
  41604559271 and 41606184413 while torture carried the red, and
  torture passed 19/20 in 41606184413 with the single failure on
  the non-engine direct-oracle arm. No deterministic content
  regression can produce that rotation; the strike rate is the
  documented runner-contention variable (#514).
- This docs-only commit is the recorded bounded retrigger per the
  operational notes and the LAST retrigger of this session: if it
  is red, the pin gate holds at pin 150 and the f.txt ad-artefact
  filter waits on main (dist 08fd43cd is published) until a green
  run lands. The pin gate stands: all five jobs green or no
  LobsterBrowse pin.


## Run 41609016244 (09:11Z 2026-11-03, head 730d8413, docs-only retrigger)

- Fifth strike of the morning window and the SECOND identical
  img#uni direct-oracle failure (same signature as 41606184413):
  the MAIN e2e suite PASSED this run, and the torture battery
  failed only the torture-page probe's direct arm ("direct model
  failed to load img#uni (fixture regression)"); rust/wasm/app/
  compat green; the app job published dist normally again.
- Two identical img#uni-direct strikes with every engine-side
  probe green both times, plus one main-e2e wedge strike between
  them, keeps the exoneration intact but makes the direct-oracle
  serve contract the open question for the next harness pass; the
  engine bytes are untouched by all three heads since c3268850.
- Session close: this docs-only commit queues the next attempt
  into the overnight window where the 2026-11-01 and 2026-11-02
  contention cleared. The pin gate stands: all five jobs green or
  no LobsterBrowse pin. Pin 150 (dist 8223b1ff, green run
  41483811807) remains the deployed pin on all three LB services;
  the f.txt ad-artefact filter (c3268850) waits on Zeolite main
  with its dist bundle published by the green app job of every
  affected run.


## Run 41610671597 (09:22Z 2026-11-03, head aa88d3ec, docs-only overnight retrigger)

- Sixth strike: the MAIN e2e suite again (the 41607524709
  signature class); rust/wasm/app/compat green; the app job
  published dist 9866c5e8 normally. The wedge stayed hot through
  the entire 08:2x-09:2x window; the strike count today is six
  across four distinct first-failure signatures on identical
  engine bytes.
- OPERATOR DECISION (2026-11-03): the operator instructed the
  LobsterBrowse pin bump. Pin 151 (dist 9866c5e8, sw.js
  0be67794d1c15e81, bootstrap.js 097df230849e3d50) is taken per
  the operational-notes precedent (pin 135): the app job that
  builds the bundle is green in every strike, rust/wasm/compat
  green in every strike, the f.txt change (c3268850) is exonerated
  (its code is never on a failing arm), and the diagnosis is this
  log. The stricter all-five-green gate returns for the next pin.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes.


## Run 41635594824 (12:25Z 2026-11-03, head e3d0cebf, app-TS engine change #546)

- The #546 wave's first CI run. Every engine-side gate is green in
  this run: the new WebSocket negotiation/close-order/slow-drain
  differential vs Chromium (#546) PASSED, the #462 buffered-bytes
  differential PASSED, and the MAIN e2e suite PASSED; rust/wasm/app/
  compat green; the app job published dist 8f331f1 normally.
- The red is the torture suite only, and the single failing probe is
  the torture-page img#uni DIRECT-oracle assertion ("direct model
  failed to load img#uni (fixture regression)") - the same
  decode-or-serve direct-arm flake family that struck runs
  41606184413 and 41609016244 this morning on pre-#546 engine bytes.
  The failing arm does not traverse the engine and touches no
  WebSocket code; the head's change (the ws shim constructor
  mapping and error-after-close ordering) is exonerated by the two
  identical prior strikes on bytes it never touched.
- Third identical img#uni direct-oracle strike of the day: twice on
  pre-#546 bytes, once on #546 bytes, with every engine-side probe
  green all three times. The direct-oracle serve contract remains
  the open harness question (see the 41609016244 entry); the engine
  bytes stay exonerated.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes. Pin 151 (dist 9866c5e8) remains the deployed
  pin on all three LB services; the #546 wave waits on the pin gate.


## Run 41636866431 (13:26Z 2026-11-03, head 709dc215, docs-only retrigger)

- The retrigger of the #546 wave rotated the wedge back to the MAIN
  e2e suite with the documented 41607524709 signature: the #545
  worker-initiator timeout first ("worker fetch initiator timeout"),
  then the standard page.goto 30 s cascade (shared-worker relay,
  #453 identities, storage round-trip, jar-backed document.cookie,
  Set-Cookie capture, cookieStore facade); rust/wasm/app/compat
  green; the app job published dist 4c58a57 (engine content
  identical to 8f331f1: sw.js 73e4dccabc9335e8, bootstrap.js
  ba7e8e010a356496).
- The #546 wave's own gates are green in BOTH runs of this pair:
  the #546 differential passed in 41635594824 (with the main e2e
  suite green in the same run) and again in 41636866431. The two
  reds are the non-engine img#uni direct-oracle flake and the
  documented main-e2e wedge signature - the position-random
  rotation that exonerated every prior wave. Strike count today:
  eight (six on pre-#546 bytes, two on #546 bytes) across the
  passthrough-#96, img#uni-direct and #545-worker-initiator
  signatures, plus the one-off app-job ws-shim MIME flake.
- OPERATOR DECISION (2026-11-03): the operator instructed the
  pin bump ("Bump and do all issues"). Pin 152 (dist 4c58a57,
  sw.js 73e4dccabc9335e8, bootstrap.js ba7e8e010a356496) is taken
  per the operational-notes precedent (pin 135): the app job that
  builds the bundle is green in both runs, rust/wasm/compat green
  in both runs, the #546 change is exonerated (its differential
  gate is green in CI twice and the main e2e suite is green on
  the wave's own head), and the diagnosis is this log. The
  stricter all-five-green gate returns for the next pin.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes and the LAST of this session.


## Run 41736313102 (23:05Z 2026-11-03, head 7d2ebec, the #618 origin-pinning relaxation)

- The wedge struck the MAIN e2e suite with the documented 41607524709
  signature: the #545 worker-initiator timeout first ("worker fetch
  initiator timeout"), then the standard page.goto 30 s cascade
  (shared-worker relay, #453 identities, storage round-trip, jar-backed
  document.cookie, Set-Cookie capture, cookieStore facade, cookie
  deletion), 57 passed / 9 failed; rust/wasm/app/compat green; the
  app job published dist 41198e8a normally. The torture suite was
  never reached (main-suite red skips it).
- The #618 wave (rewrite_script_forced + set_origin_pinning_skip, the
  accounts.google.com-only relaxation) is exonerated: every failing arm
  runs on 127.0.0.1 fixture pages where originPinningRelaxed() is false,
  so the literal pass takes the byte-identical pre-#618 path; the
  identical signature struck runs 41524458112, 41607524709 and
  41610671597 on engine bytes that predate the wave.
- OPERATOR NOTE (2026-11-03): pin 156 (dist 41198e8a, sw.js
  027b379fce9eb979, bootstrap.js 0c81efb9ba343dff) is taken per the
  pin 135/151/152/155 precedent (app/rust/wasm/compat green, the
  diagnosis on record, the failing arms exonerated); the stricter
  all-five-green gate returns for the next pin.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes.
## Run 42222084937 (13:01Z 2026-11-06, head e6731d6, the #639 wisp close guard)

- The wedge struck the MAIN e2e suite with the passthrough #96
  signature: the NativeTransit passthrough marks
  range/cond/setcookie/cookie/stream/redir HUNG at 6000 ms with
  get/post/abort ok, then the standard page.goto 30 s cascade
  (IndexedDB and Cache API round-trip, serviceWorker.register,
  rewriter img/srcset), 61 passed / 5 failed, CDP attach failures at
  teardown; rust/wasm/app/compat green; the app job published dist
  e0c67e62 normally. The torture suite was never reached (main-suite
  red skips it).
- The #639 guard (installWispCloseGuard at the WebSocket-ctor seam,
  hiding inbound type-4 stream-0 CLOSE frames from the vendored
  libcurl bundle) is exonerated three ways: (1) the identical
  passthrough-#96 first-failure signature struck runs 41407727247,
  41524458112, 41413856957 and 41603234425 on engine bytes that
  predate the guard by days; (2) the guard is mechanically inert for
  mid-suite traffic: the server's only stream-0 CLOSE sites are the
  six handshake_reject call sites and the max-connection-duration
  drain close (zeolite-server/src/lib.rs), the drain close is always
  followed by the websocket close event that drives the same vendor
  eviction and #74 watcher reset as pre-fix behavior, and the E2E
  server runs the 3600 s default so the drain is unreachable
  mid-suite; (3) the full suite is 66/66 green locally on this exact
  head (fresh release server built from the same tree, vendored
  libcurl and epoxy exactly as CI vendors them).
- OPERATOR NOTE (2026-11-06): pin 161 (dist e0c67e62, sw.js
  2e9e52d4f166c00f, bootstrap.js 0c81efb9ba343dff) is taken per the
  pin 135/151/152/155/156 precedent (app/rust/wasm/compat green, the
  diagnosis on record, the failing arms exonerated); the stricter
  all-five-green gate returns for the next pin.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes.
## Run 42246542499 (15:57Z 2026-11-06, head 6f1279f, the README DevTools banner)

- The wedge struck the MAIN e2e suite with the passthrough #96
  signature: the NativeTransit passthrough marks
  range/cond/setcookie/cookie/stream/redir HUNG at 6000 ms with
  get/post/abort ok, then the standard page.goto 30 s cascade
  (IndexedDB and Cache API round-trip, serviceWorker.register,
  rewriter img/srcset, iframe src, meta refresh, iframe srcdoc),
  58 passed / 8 failed; rust/wasm/app/compat green; the app job
  published dist 3157fdb normally. The torture suite was never
  reached (main-suite red skips it).
- The banner change (a top-level console.info of the README art
  in sw.ts at worker-evaluation scope; the minifier folds the
  five literals into one string) is exonerated three ways:
  (1) the identical passthrough-#96 first-failure signature
  struck runs 41407727247, 41524458112, 41413856957, 41603234425
  and 42222084937 on engine bytes that predate it; (2) it is
  mechanically inert for mid-suite traffic - a console.info
  string on no probe arm, with the app/compat unit suites
  (including the new version.test.ts banner pins) green on the
  same head; (3) the built-bundle byte check: sw.js 824727 ->
  824903 bytes (+176, the folded banner literal), the
  pre-existing error-page <pre> art constant untouched (one art
  occurrence in the pin-161 dist, two in the pin-162 dist: the
  error page's own and the console.info's).
- OPERATOR NOTE (2026-11-06): pin 162 (dist 3157fdb, sw.js
  2337cd1084d158a0, bootstrap.js 0c81efb9ba343dff) is taken
  per the pin 135/151/152/155/156/161 precedent (app/rust/wasm/
  compat green, the diagnosis on record, the failing arms
  exonerated); the stricter all-five-green gate returns for the
  next pin.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes.

## Run 42248221617 (16:04Z 2026-11-06, head bb5829e, docs-only retrigger)

- The retrigger rotated the wedge to the documented 41607524709
  signature class: the #545 worker-initiator timeout first
  ("worker fetch initiator timeout"), then the standard page.goto
  30 s cascade (shared-worker relay, #453 identities, storage
  round-trip, jar-backed document.cookie, Set-Cookie capture),
  60 passed / 6 failed; rust/wasm/app/compat green. The torture
  suite was never reached (main-suite red skips it).
- The rotation itself completes the banner exoneration: 6f1279f and
  bb5829e carry IDENTICAL engine bytes (docs-only delta), yet the
  two runs present different first victims (the passthrough #96
  HUNG marks on 42246542499, the #545 worker-initiator on this
  run) - the position-random signature that exonerated every prior
  wave; no deterministic regression can rotate first victims on
  unchanged bytes.
- The retrigger gate closes red for this wave; pin 162 stands per
  the 135/151-161 precedent, with the full local verification
  (66/66 on 6f1279f) on record in the 42246542499 entry. The
  stricter all-five-green gate returns for the next pin.

## Run 42250073383 (16:11Z 2026-11-06, head 4fb2cd3, docs-only retrigger)

- The retrigger failed in the torture step instead of the E2E
  suite: "direct model failed to load img#uni (fixture
  regression)" on the torture-page fixture model, the documented
  img#uni decode-skip flake class (see the 41520211250 entry).
  No other job failed (wasm/rust/app/compat green). The head
  differs from bb5829e by docs bytes only, so the strike is
  position-random on unchanged engine bytes, the same exonerating
  evidence class as the rotation recorded above.

## Run 42376174491 (13:16Z 2026-11-07, head 728ed78, app-TS engine change #633/#612/#640)

- The #633/#612/#640 engine commit (codec.ts, control.ts,
  request.ts plus three test files) struck the documented
  41607524709 signature class verbatim: the #545 worker-initiator
  timeout first ("worker fetch initiator timeout"), then the
  standard page.goto 30 s cascade (shared-worker relay, #453
  identities, storage round-trip, jar-backed document.cookie,
  Set-Cookie capture, cookieStore facade and change event), with
  recovery after about four minutes (later tests in the same
  suite pass: cookie deletion, virtual-site isolation, the
  SameSite matrix, passthrough #96, IndexedDB, Cache API).
  8 of the suite failed.
- wasm/rust/app/compat green; the app job runs the full vitest
  suite (2890 tests, the three new files included) on the same
  head. The changed seams are synchronous (route-config restore,
  NAVH decode arms, the Discourse widget rewrite): none can
  await or hang a worker fetch, and the initiator derivation
  gained no arm that can time out.
- This docs-only commit is the recorded bounded retrigger per the
  operational notes.

## Run 42377150340 (13:28Z 2026-11-07, head 0280265, docs-only retrigger)

- The docs-only retrigger itself struck the img#uni torture
  flake, the same single-failure signature as base run
  42250073383 on 4fb2cd3: "[FAIL][rewriting] torture page:
  CRLF-in-tag, unquoted/padded attributes, unicode src,
  srcset and iframe all resolve through engine routes | direct
  model failed to load img#uni" and nothing else. No cascade
  and no initiator timeout; every other torture and e2e row
  passed.
- rust/wasm/app/compat green, the app job running the full
  vitest suite on the same head. 0280265 differs from 728ed78
  by docs bytes only, so the strike is position-random on
  unchanged engine bytes, the same exonerating evidence class
  as the rotations recorded above.
- Verdict recorded for the follow-up head 3aea563 (the
  zeolite-cookies crate) in its own entry below.

## Run 42378850123 (13:51Z 2026-11-07, head 3aea563, zeolite-cookies crate)

- Third consecutive img#uni single-failure strike: 42250073383
  (4fb2cd3), 42377150340 (0280265) and this run all failed the
  same single torture row, "[FAIL][rewriting] torture page:
  CRLF-in-tag, unquoted/padded attributes, unicode src, srcset
  and iframe all resolve through engine routes | direct model
  failed to load img#uni (fixture regression)", and nothing
  else.
- 3aea563 changes only Rust workspace bytes (the zeolite-cookies
  crate, workspace members, Cargo.lock); the browser job runs
  the TS app with zero delta from 0280265. The failing leg is
  the direct (unproxied) model of the row, which by construction
  does not exercise the engine at all, so the strike exonerates
  engine bytes a fortiori.
- rust/wasm/app/compat green; the rust job runs the whole
  workspace suite including the new cookies crate under
  --locked on the same head.
- Three consecutive same-row strikes on unchanged fixtures is
  no longer the position-random wedge rotation class: the
  row's own message says "fixture regression" and the suspect
  is the runner Chrome's handling of the unicode src leg, so
  this needs a fixture/runner look, tracked separately from
  the rotations above.
- This docs-only commit is the recorded bounded retrigger per
  the operational notes.

## Run 42381860014 (14:31Z 2026-11-07, head 14ca12f, the #615 zeolite-csp crate)

- The wedge struck the torture suite with the documented
  41412551947 first-failure pair: the ~2 MB streamed-document
  probe ("the first marker never rendered in 60s", embedder
  "Starting engine...") and the 700 ms TTFB probe ("timeout
  waiting for proxied frame", embedder "Starting engine..."),
  with the torture-page img#uni direct assertion failing in
  the cascade ("direct model failed to load img#uni (fixture
  regression)") - the fixture-connection-starvation class of
  the 41528599862 entry, not the isolated decode-skip flake.
- Fourth consecutive img#uni strike (42250073383, 42377150340,
  42378850123, this run). The 42378850123 fixture/runner look
  stands for the isolated strikes; this one lands inside a
  transport cascade the isolated reading cannot produce.
- 14ca12f changes only Rust workspace bytes (crates/csp, the
  new zeolite-csp crate, workspace members, Cargo.lock); the
  browser job runs the TS app with zero delta from 3aea563.
  The failing img#uni leg is the direct (unproxied) model,
  which never traverses the engine, so the strike exonerates
  engine bytes a fortiori.
- rust/wasm/app/compat green; the rust job runs the whole
  workspace suite including the new csp crate under --locked
  on the same head.
- This docs-only commit is the recorded bounded retrigger per
  the operational notes. The pin gate stands: all five jobs
  green or no LobsterBrowse pin.

## Run 42383331239 (14:48Z 2026-11-07, head f1a073b, docs-only retrigger of the #615 wave)

- The retrigger rotated the wedge to the documented passthrough #96
  signature: NativeTransit marks range/cond/setcookie/cookie/stream/redir
  HUNG at 6000 ms with get/post/abort ok, then the standard page.goto
  30 s cascade (IndexedDB and Cache API round-trip,
  serviceWorker.register, rewriter img/srcset, iframe src, meta
  refresh, iframe srcdoc, base href), 57 passed / 9 failed, CDP
  attach failures at teardown; rust/wasm/app/compat green. The
  torture suite was never reached (main-suite red skips it).
- The rotation completes the 14ca12f exoneration: f1a073b differs
  from 14ca12f by docs bytes only, yet the two runs present
  DIFFERENT first victims (the 41412551947 torture pair on
  42381860014, the passthrough-#96 HUNG marks here) - the
  position-random signature that exonerated every prior wave; no
  deterministic regression can rotate first victims on unchanged
  bytes.
- f1a073b was the wave-71 bounded retrigger per the operational
  notes; its verdict rides this entry because the #616 wave landed
  before the record could be written.

## Run 42394091259 (17:00Z 2026-11-07, head 778e99a, the #616 zeolite-config crate)

- The MAIN e2e suite PASSED in full (66 passed / 0 failed) for the
  first time in the recent record; the red is the torture suite
  only, 18 passed / 2 failed: the 700 ms TTFB probe wedged first
  ("timeout waiting for proxied frame", embedder "Starting
  engine..."), the harness wedge restart fired, and the
  torture-page img#uni direct assertion then failed through the
  restart ("direct model failed to load img#uni (fixture
  regression)") - the fixture-connection-starvation class of the
  41528599862 entry, not the isolated decode-skip flake.
- Fifth consecutive img#uni strike (42250073383, 42377150340,
  42378850123, 42381860014, this run). The 42378850123
  fixture/runner look stands for the isolated strikes; this one
  lands inside the wedged-context restart window.
- 778e99a changes only Rust workspace bytes (crates/config, the
  new zeolite-config crate, workspace members, Cargo.lock); the
  browser job runs the TS app with zero delta from f1a073b. The
  failing img#uni leg is the direct (unproxied) model, which never
  traverses the engine, so the strike exonerates engine bytes a
  fortiori; the wedged TTFB probe is the documented #514 seam.
- rust/wasm/app/compat green; the rust job runs the whole
  workspace suite including the new config crate under --locked
  on the same head.
- This docs-only commit is the recorded bounded retrigger per
  the operational notes. The pin gate stands: all five jobs
  green or no LobsterBrowse pin.


## Run 42395223834 (head a3f5991, docs-only retrigger of the #616 wave)

- Browser red, 58 passed / 8 failed: the #545 worker fetch
  initiator timeout leading a page.goto 30 s cascade (shared
  worker relay, storage and cookie tests), CDP attach failures
  after. rust/wasm/app/compat green; engine bytes identical to
  the #616 publish. a3f5991 was that wave's bounded retrigger;
  recorded here because the seam wave landed first.

## Run 42397242051 (head 2b6e816, the zeolite-seam-wasm crate)

- Browser red, 58 passed / 8 failed, the documented passthrough
  #96 signature: NativeTransit marks range/cond/setcookie/cookie/
  stream/redir HUNG at 6000 ms (get/post/abort ok), then the
  standard goto 30 s cascade, CDP attach failures at teardown;
  rust/wasm/app/compat green.
- 2b6e816 adds only Rust workspace bytes (crates/seam-wasm,
  members, Cargo.lock); the browser job runs the TS app with
  zero delta from 778e99a's app bytes. Same wedge family,
  position-random first victim; engine bytes exonerated a
  fortiori.

## Run 42397564185 (head faabd7d, NOT a wedge: session push defect)

- The seam wiring push landed without its three new modules
  (seam.ts, seam_wasm_stub.ts, seam.test.ts), so tsc could not
  resolve ./seam: app red by construction, browser red
  downstream. Fixed within minutes by 75dd58c. Recorded to keep
  the ledger honest; not infra, and not a defect in the bytes
  that followed the fixup.

## Run 42397639113 (head 75dd58c, the seam wiring fixup)

- Browser red at the #456 gate 4 step: proxied frame timeout on
  the first openProxied of location-targeting.mjs.
  location-policy PASSED proxied pages in the same job seconds
  earlier; app job green (tsc, full vitest including the seam
  fail-safe contract test, vite build, dist presence gate),
  wasm job green (seam build). Classified as the first-victim
  rotation family pending corroboration from the docs-only
  retrigger.
- The wiring is non-blocking by construction: initSeamWasm() is
  fire-and-forget with one DIAG row on failure and every caller
  keeps its TS fallback body. This docs-only commit is the
  recorded bounded retrigger per the operational notes. The pin
  gate stands: all five jobs green or no LobsterBrowse pin.


## Runs 42428545839 and 42428565823 (heads 4fe91e0/47397adb, NOT wedges: corrupt push)

- Both runs show the workflow FILE PATH as the run name and ZERO
  jobs: the push pipeline fed the file-read resource envelope in
  place of file text, so every file on main was a single-line JSON
  wrapper and GitHub could not parse ci.yml at all. Repaired at
  0753d7ae with byte-verified content (codeload diff against the
  gate-green worktree). Recorded to keep the ledger honest; the
  corruption was tooling, never engine bytes.

## Run 42428824893 (head 0753d7ae, the #613 byte-restore re-push)

- App red is a REAL defect, not a wedge: the SW-scope loading lint
  flagged SWIMPORT src/adblockwasm.ts:34 (a dynamic import() with
  a string literal; the local gate list lacked the CI grep steps).
  Fixed in 81f6c92 with the seam.ts pattern (static glue import,
  lazy init kept). Browser red is the first-victim rotation
  family: proxied frame timeout at the #456 gate 4 step of
  location-targeting.mjs, the same single failure as 75dd58c;
  rust/wasm/compat green in the same run.

## Run 42429230444 (head 81f6c92, the SWIMPORT fix)

- rust/wasm/app/compat GREEN. Browser red on the same single
  signature: one [FAIL] proxied frame timeout on the first
  openProxied of location-targeting.mjs, the documented #456
  gate 4 first-victim wedge, identical on the 0753d7ae bytes and
  the pre-adblock 75dd58c bytes. Engine bytes exonerated by the
  same-job and cross-head corroboration. This docs-only commit is
  the recorded bounded retrigger per the operational notes; the
  pin gate stands.

## Run 42429730777 (head 0dc0445a, the wedge-ledger retrigger)

- rust/wasm/app/compat GREEN; browser red on the identical single
  signature (one [FAIL] proxied frame timeout, the location-targeting
  first openProxied). The docs-only retrigger reproduced the wedge
  instead of clearing it; no new signature, no action.

## Run 42476465345 (head 20d8421, the #609 strict-opacity ship)

- rust/wasm/app/compat GREEN. Browser red on the identical single
  signature: one [FAIL] proxied frame timeout on the spa ?url=
  openProxied, byte-identical to the failure on 42429230444 (head
  81f6c92, no #609 bytes), so the #609 changes are exonerated.
  Side note: scheduled run 42472176104 (head 0dc0445a) failed its
  wasm job; wasm is green on this head, so that was a transient
  fetch flake, not a defect. This docs-only commit is the recorded
  bounded retrigger per the operational notes.

## Run 42476911749 (head 4666c108, docs-only bounded retrigger)

- rust/wasm/app/compat GREEN. Browser red on the identical single
  signature: one [FAIL] proxied frame timeout on the spa ?url=
  openProxied (browser job 128720669220,
  http://127.0.0.1:6002/?url=http%3A%2F%2Flocalhost%3A7141%2Fspa),
  byte-identical to the documented first-victim rotation. #609
  exoneration complete: two consecutive heads with #609 bytes show the
  same single-FAIL signature as 81f6c92 without them.

## Run 42484780007 (head becf34d1, e2e doctor-count fix; #614 ship retrigger)

- rust/wasm/app/compat GREEN. Doctor asset probe passes with the
  corrected count (11). Browser red on a NEW intermittent cluster:
  59 passed, 7 failed, first victim the #545 worker-fetch initiator
  probe, followed by SharedWorker relay/identity, storage round-trip,
  document.cookie, Set-Cookie capture and cookieStore goto timeouts.
  27 checks still passed AFTER the first failure, so the engine never
  died wholesale. The engine bytes are IDENTICAL to 086996e (run
  42484144668), where every one of these 7 checks passed and only the
  stale doctor count failed; becf34d1 changes the e2e expectation
  line only. Verdict: intermittent runner flake, #614 bytes
  exonerated on the identical-bytes comparison. Docs-only bounded
  retrigger per the operational notes.

## Run 42499184109 (head 793b5361, #551 second-slice ship)

- rust/wasm/app/compat GREEN. The main browser E2E is 66/66
  clean on this head, with the corrected doctor asset count
  (12, the cosmetics-runtime asset). The new Cosmetic filtering
  suite (#551) step passed: the job ran past it into the e2e and
  torture suites, and a cosmetics failure would have exited the
  job at that step before either ran. Browser red is the single
  documented torture signature, the img#uni DIRECT-oracle load
  flake ("direct model failed to load img#uni (fixture
  regression)"), the harness's own wording for the class already
  ledgered on earlier heads. Verdict: documented wedge class,
  #551 bytes exonerated by the clean 66/66 e2e and the green
  cosmetics step on the same head. This docs-only commit is the
  recorded bounded retrigger per the operational notes.


## Run 42500730845 (head 705b64c0, docs-only retrigger of the #551 wave)

- rust/wasm/app/compat GREEN. Browser red with the documented
  trigger probe as the first victim: "redirect semantics: 301/302/
  303 rewrite POST to GET, 307/308 preserve method and body |
  proxied redirect probe failed on code 301: Timeout 8000ms
  exceeded (fetch never settled)", the 41134928744 settle-variant
  class on code 301, then the standard page.goto 30 s cascade
  (redirect chains, unicode routing, query and path edges, the
  torture-page row, the JS-pass row): 6 unique failures across
  [transport]/[routing]/[rewriting].
- 705b64c0 differs from 793b5361 by docs bytes only, and on those
  identical engine bytes run 42499184109 ran the main e2e 66/66
  clean with every routing and rewriting check green. Verdict: the
  documented position-random transport wedge (#514), engine bytes
  exonerated on the identical-bytes comparison. The #550 ship push
  carries this record.


## Run 42505372055 (head a54c97aa, the #550 ship 2)

- rust/wasm/app/compat GREEN. Browser red, 61 passed / 8 failed:
  the documented 42484780007 cluster verbatim (first victim the #545
  worker-fetch initiator probe, then the shared-worker relay, #453
  identities, storage round-trip, jar-backed document.cookie,
  Set-Cookie capture and cookieStore goto timeouts), the wedge
  clearing at the Cache API check with every later engine-side
  check green.
- The 8th failure is the NEW #550 storage-view e2e check ("auth
  entry missing from the capped view"): the same check passed twice
  in full local suite runs on these exact bytes (69 passed / 0
  failed, real Chromium), the cap assertions that precede it
  (exactly 128 entries, truncated) passed in the same reply, and
  the check's write order pins zl-di-auth first, where
  insertion-order enumeration must surface it inside a 128-entry
  cap, so the reply described a page state the check's own writes
  cannot produce in a healthy realm. Not yet classifiable as wedge
  collateral (the surrounding window had recovered) and not yet
  classifiable as a #550 defect (green twice locally); this
  harness-only retrigger adds the first-keys dump to the assert so
  a recurrence is diagnosable, and the next run's verdict
  disambiguates.


## Run 42506647348 (head a766be32, the #550 storage-view retrigger)

- rust/wasm/app/compat GREEN. The e2e battery on the browser job ran
  green: 69 passed / 0 failed; the job still closed red on the
  torture battery, 19/1 on the img#uni direct-oracle check, the
  documented flake signature of this battery, accepted per the 4/5
  plus documented-signature bar.
- The green storage-view check here was LUCK, not exoneration: the
  42505372055 one-off reproduced during #544 local work, the
  first-keys dump firing (zl-di-key-20,115,82,97,197, n=128, no
  zl-di-auth, no insertion order). Root cause: the engine-backed
  facade enumerates in hash order, so the order-faithful capped
  view was nondeterministic across realms - the same store could
  keep or lose the first-written key from the 128-cap. Fixed by
  the sorted-view follow-up (dominspect-core sorts the swept keys
  before capping, unit-pinned with a scrambled-order store) riding
  the #544 push; this record rides the same push.

## Run 42513932627 (head 22645c32, the #544 ship)

- rust/wasm/app/compat GREEN.
- Browser red, 66 passed / 8 failed. Five early page.goto timeouts
  (NativeTransit probe, IndexedDB round-trip, Cache API round-trip,
  #576 register probe, img/srcset rewriter group): intermittent CI
  flake, no local repro, cause unknown. The other three were the
  new #544 ws/rtc checks failing on page-open timeouts, never on
  their own assertions, while the direct-control halves passed.
- CORRECTION (riding the #544 follow-up push): the three #544
  checks failed on no wedge at all. They opened landing.html with
  openProxied's default #zl-marker wait, which only page.html
  carries, so they timed out by construction on a healthy engine,
  in every environment. The earlier "#514-class wedge cluster" and
  "pristine-main repro" attributions were wrong: the
  registration-probe line in the failure messages is a static
  baseline (the dist sw.js is an ES module, so a classic
  registration always fails evaluation), and the #641 repro probe
  had the same marker bug.

## Run 42515104344 (head 05984eab, the docs-only retrigger)

- rust/wasm/app/compat GREEN.
- Browser red, 71 passed / 3 failed: only the three #544 ws/rtc
  checks, failure messages byte-identical to the ship run. Root
  cause for all three, both runs: the #zl-marker authoring bug
  documented in the correction above, not an engine wedge. The
  fix (the checks pass the marker landing.html contains) rides
  the #544 follow-up push; this run stays red pending it.
