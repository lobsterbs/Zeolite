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

Current release: **2.3 Selenide** (cargo `2.3.0`). The 2.x line opens a
new substance family; the roadmap's 1.x -ide sequence is complete.
2.1 Halogen's gates landed with the 2.0 version string still in the
code; no 2.1 release was cut, the string moved at 2.2 Arsenide.
2.3 Selenide completes worker virtualization (module-worker specifier
pass, SharedWorker WebSocket bridge, worker and OffscreenCanvas
fingerprint patches) and ships the issue-tab fixes: engine-route CORS
response-header surgery and the engine-owned navigation error page.
