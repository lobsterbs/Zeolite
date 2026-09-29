# Zeolite versioning

Zeolite versions are `MAJOR.MINOR "Substance"`, for example **1.0 Nitride**
or **1.3 Carbide**.

- The numeric part follows semver: MAJOR breaks compatibility, MINOR adds
  capability. In Cargo the version is `MAJOR.MINOR.0` (the patch digit is
  not part of the public identity).
- The substance is the name of a real chemical substance. Every MINOR
  release gets a new substance, and substances are never reused.
- The 1.x line uses the -ide family in roadmap order (Nitride, Oxide,
  Halide, Carbide, Boride, Silicide, Hydride, Sulfide, Telluride,
  Fullerene); later majors pick new families (2.x opens with Graphene).
- The substance is part of the public version, not decoration: it is
  printed by the server at startup, exposed as `zeolite_rewriter::VERSION`,
  exported by the service worker as `ZEOLITE_VERSION`, and returned in the
  `zl:getNetLog` reply so tooling can pin and display it.

Current release: **2.5 Iodide** (cargo `2.5.0`). The 2.x line opens a
new substance family; the roadmap's 1.x -ide sequence is complete.
2.1 Halogen's gates landed with the 2.0 version string still in the
code; no 2.1 release was cut, the string moved at 2.2 Arsenide.
2.3 Selenide completes worker virtualization (module-worker specifier
pass, SharedWorker WebSocket bridge, worker and OffscreenCanvas
fingerprint patches) and ships the issue-tab fixes: engine-route CORS
response-header surgery and the engine-owned navigation error page.
2.4 Bromide closes rewriter parity: standalone stylesheets stream
through the wasm CSS rewriter chunk by chunk instead of buffering the
whole body (byte-identical to the one-shot pass; only the incomplete
url( tail is held between chunks), and the deep adapter integration
consumes the engine control plane: session export/import and the
downloads registry UIs in the adapter use the engine implementations
instead of parallel ones. The planned zeolite-server arena-reuse item
was resolved by audit: the server relays opaque wisp bytes, so there
are no server-side rewrite paths to pool.
2.5 Iodide is the Phase 15 release: scoreboard expansion and real-site
probes. The compat suite is rebuilt on the real engine surface: the 1.9
suite probed a plain-HTTP fixture origin zeolite-server never exposed,
and its first executed run returned 404 on every probe; the 2.5 suite
rides wisp v2.1 (CONNECT tunnel, raw HTTP/1.1 inside) and the
real-destination probes pass in CI (run 36479436783). Replay now also
compares the recorded WebSocket lifecycle and cookie-jar shape against
the artifact contract. The issue-tab backlog closes with this release:
#4, #10, #12, #13, #17, #18 fixed and gated, #5-#9 closed as harness
false alarms, and the mirror route scheme is wired through every encode
path with unit gates (#20). Known honestly open: real-site mirror
verification stays with the embedder's browser suite (CI runs no
browser by design), and the nightly compat schedule's port fix is
pending its first cron run.
