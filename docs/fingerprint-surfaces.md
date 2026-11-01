# Fingerprint surface inventory

schemaVersion: 1

Every surface the FingerprintProfile controls, with the scope it is
patched in, the test file that pins it, and an honest status. This
inventory is versioned because the profile contract itself is versioned:
a change to what the profile controls (not just how) bumps the schema
version. #540 narrowed the timezone contract to a self-consistent fixed
offset; everything else is unchanged.

Statuses, defined honestly:

- **controlled** - the profile value fully determines what the surface
  reports in that scope.
- **partially controlled** - the profile determines part of the surface;
  the documented remainder stays native or is a known limit.
- **native** - the engine deliberately does not touch the surface.

| Surface | Profile field | Page scope | Worker scope | Test file | Status |
| --- | --- | --- | --- | --- | --- |
| User-Agent / appVersion | `userAgent` | patched (`Navigator.prototype`) | patched (`WorkerNavigator`) | `src/__tests__/useragent.test.ts`, `fingerprint.test.ts` | controlled (when `matchUserAgent`; native when false) |
| platform | `platform` | patched | patched | `useragent.test.ts`, `fingerprint.test.ts` | controlled |
| Client Hints (low + high entropy) | derived from `userAgent` | patched on NavigatorUAData (not created where absent) | patched | `useragent.test.ts` | partially controlled: unsupported high-entropy fields stay absent, never invented; wire headers agree |
| languages | `languages` | patched (`language`/`languages`) | patched | `fingerprint.test.ts`, `useragent.test.ts` | controlled; also drives the upstream `Accept-Language` |
| timezone identity (Intl default) | `utcOffsetMin` / `timezoneName` | patched: Intl.DateTimeFormat default timeZone is the explicit name, else the canonical Etc/GMT zone (offset string for half-hours) | same patch | `fingerprint.test.ts` (#540 describe) | controlled within the narrowed fixed-offset contract; no tz database, so non-Etc names are never verified |
| Date surface | `utcOffsetMin` | patched: getTimezoneOffset + local getters as a fixed offset; toString/toTimeString zone text formatted from the offset (Chromium Etc shape); toJSON stays UTC ISO (as real Chromium in every zone) | same patch | `fingerprint.test.ts` (#540 describe) | controlled: fixed offset only. DST is never simulated - Etc/GMT zones never observe DST, stated not hidden |
| hardwareConcurrency | `hardwareConcurrency` | patched | patched | `fingerprint.test.ts` | controlled; null = native |
| deviceMemory | `deviceMemoryGB` | patched | patched | `fingerprint.test.ts` | controlled; null = native |
| screen shape | `screen` | patched (`Screen.prototype` 6 fields) | not applicable (no Screen in workers) | `fingerprint.test.ts` | controlled in page scope; `window.outerWidth/Height` and viewport are native |
| WebGL unmasked vendor/renderer | `webglVendor` + `webglRenderer` | patched (UNMASKED_VENDOR/RENDERER params, both context versions) | patched (contexts via OffscreenCanvas) | `fingerprint.test.ts` | partially controlled: the rest of the GL parameter surface stays native; GPU-side fingerprinting (shader timing, driver quirks) out of scope |
| audio noise | `audioNoise` (+ `canvasSeed`) | AnalyserNode float/byte frequency reads | not patched in workers (no AnalyserNode seam shipped) | `fingerprint.test.ts` (#141 describe) | partially controlled: opt-in deterministic noise only; other audio paths native |
| canvas pixel output | `canvasSeed` | read-time perturbation on toDataURL/toBlob/getImageData copies; the live canvas is never written back | same perturbation on OffscreenCanvas convertToBlob/transferToImageBitmap/getImageData | `canvas-perturb.test.ts` | partially controlled: other read paths (e.g. captureStream) are not covered |

## Undeclared surfaces (deliberately native or transport-owned)

- Fonts (enumeration, metrics) - native.
- Timing (performance.now resolution, event loop jitter) - native; the
  transport adds latency and documents rather than smooths it.
- TLS / HTTP2 fingerprint (JA3/JA4, ALPN, SETTINGS) - transport-owned
  by design; no profile field can change it (see docs/fingerprint.md,
  "Transport engine binding").
- navigator.serviceWorker and registration state - honestly native
  (documented detection surface, #141).
- Worker-only surfaces with no document counterpart (a worker's own
  `import.meta`, heap usage) - native.
- WebRTC - transport-owned; see the capability-report wave (#544).

A surface not listed in either table is not claimed, not partially
claimed, and not silently patched: if it is ever controlled, it lands
here with a schemaVersion bump first.
