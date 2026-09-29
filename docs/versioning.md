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

Current release: **3.0 Diamond** (cargo `3.0.0`). The 2.x line opened a
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

3.0 Diamond is the Phase 16 hardening release and closes the roadmap.
The security audit was re-run against everything added since 2.0
(redirect-hop cookie capture, the SameSite opt-in knob, merge-mode
session import, the SharedWorker bridge, module-worker specifier
rewriting, engine-route CORS surgery, the engine error page, the
antiframe pass, the streaming CSS rewriter, scheme rotation and the
mirror route scheme); stale 2.0-era findings were corrected in
docs/security.md. The performance audit was refreshed at the 2.5-era
artifact sizes (CI run 36530935953: rewriter wasm 72,242 bytes, wisp
wasm 26,454 bytes, bootstrap 5,068 bytes minified, 2.17 kB gzip,
under the 5120 gate). The matrix is re-rated at 3.0. The public API
is frozen for the 3.x line: the zl: control plane, the ZeoliteEngine
adapter, the rewriter wasm interface and the codec schemes (b64u,
mirror) are the compatibility surface. Known honestly open at the
cut: craigslist root navigation dies inside the upstream wasm
transport (curl error 56 before response headers surface, issue #11,
full analysis there). It predates this line and is not a regression
of it; the redirect target on the same host loads fine and every
other probed site loads.
