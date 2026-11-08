# Filter-list compatibility: what the engine honors, per arm

Zeolite ships adblock filter-list compatibility in two arms: the
wasm arm (crates/adblock, compiled to WebAssembly, answering
network matching and cosmetic `hidden_css`) and the TS arm
(@ghostery/adblocker running in the service worker). This document
states what each arm honors, where they diverge, and why.

## Network filtering

Both arms honor, per request URL: pattern rules (`||host^`,
`/path^`, `domain=` anchors) and plain substring filters, plus
exception rules (`@@`) at the same priority. The zl:adblock toggle,
the per-site zl:rules adblock override and the captcha/anti-bot
allowlist gate every network decision identically in both arms.

## Cosmetic filtering

- Hostname- and entity-anchored hide rules: both arms, static
  splice at rewrite time (docs/interception.md).
- The generic base stylesheet: both arms, static.
- Class- and id-anchored generic hides: both arms, through the
  dynamic token bridge (#551 second slice). The page runtime
  derives DOM tokens; the worker asks the engine per token batch;
  the engine answers per-URL rules. The document URL is derived
  from the client URL, never from the page payload.
- Extended/HTML filters (`##^`, `:has()`, `:has-text()`):
  unsupported in both arms, counted in the REWRITE diagnostic
  event, never applied. One pre-existing engine quirk stays
  unchanged: filters the engine itself precompiles into its styles
  answer report `isExtended()` false and ride the static arm.
- Frame-ancestor-constrained rules: unsupported in both arms (the
  frame chain is not tracked service-worker side).

## Scriptlet filtering (+js(...))

Both arms refuse scriptlet execution at the engine seam. The wasm
arm returns an empty scriptlet list by design. The TS arm compiles
only an allowlist of defensive scriptlets:

- set-constant
- abort-on-property-read
- abort-on-property-write
- noop

Why an allowlist. Scriptlets are arbitrary JavaScript bodies from
the filter list, executed in the page realm. A tunnel browser that
executes unreviewed list bodies hands the list author code execution
in every proxied page. The allowlist ships four names with fixed
argument shapes, identifier-validated targets and bounded arguments
(16 scriptlets per page, 4 arguments each, 256 characters per
argument, 4 chain parts); a foreign scriptlet name stays an
unsupported count and never reaches the page. Raising the allowlist
requires a deliberate change here, with a regression test per name.

## Evidence

- Unit: app/src/__tests__/cosmetic-page.test.ts,
  cosmetic-tokens.test.ts, cosmetic-injection.test.ts,
  cosmetics-wasm.test.ts.
- Real-Chromium: suite/e2e/cosmetics.mjs (static hide, generic
  dynamic hide, late-insert observer, wasm scriptlet refusal,
  network block, zl:rules override, exception host, budget caps),
  CI step "Cosmetic filtering suite (#551)".
