# Fingerprinting resistance (1.8 Telluride)

Phase 8, prompt item 14. One internally-consistent config object - a
FingerprintProfile - drives every spoofed surface. The engine never
invents values and never randomizes per session: two sessions with the
same profile look identical to each other on purpose. A profile that
contradicts itself is refused, not silently merged.

## Enabling it

Post a control message to the service worker (same channel as
`zl:config`):

```js
navigator.serviceWorker.controller.postMessage({
  type: "zl:fingerprint",
  profile: { /* partial or full profile, see below */ },
});
```

Pass `profile: null` to drop back to fully native surfaces. The reply
arrives on the MessageChannel port as `{ ok: true, profile }` or
`{ ok: false, error }` with the reason a profile was rejected. Like the
adblock and tracing toggles, the fingerprint resets to native on
service-worker restart: the host re-sends it after boot.

## Profile fields

All fields are optional except `userAgent`; everything omitted stays
native except what can be derived from the UA (`platform`).

- `userAgent` - required, must be a full browser UA string.
- `platform` - derived from the UA when omitted (`Win32` for Windows
  NT, `MacIntel` for Mac, `Linux armv8l` for Android, ...). An explicit
  value that contradicts the UA is rejected.
- `languages` - array shown as `navigator.language` / `languages` and
  sent upstream as `Accept-Language`.
- `utcOffsetMin` - minutes ahead of UTC (Oslo summer: 120). Patches
  `Date.prototype.getTimezoneOffset` and the local Date getters.
- `timezoneName` - IANA zone name patched into `Intl.DateTimeFormat`.
- `hardwareConcurrency`, `deviceMemoryGB` - navigator surfaces.
- `screen` - `{ width, height, availWidth, availHeight, colorDepth,
  pixelDepth }` for `window.screen`.
- `webglVendor`, `webglRenderer` - the UNMASKED_VENDOR /
  UNMASKED_RENDERER strings; both or neither.
- `canvasSeed` - deterministic seed for canvas perturbation.

The default profile (used when the host asks for the default rather
than supplying one) is a coherent Chrome-on-Windows desktop.

## What is spoofed and where

The service worker compiles the profile into an init script once and
prepends it to the `window.__ZL` init chunk it already emits at the
start of every rewritten HTML document. Engine-initiated upstream
requests carry the profile `User-Agent` and `Accept-Language`, so the
document surface and the wire surface agree.

Since 2.3 Selenide the same profile is compiled a second time, into a
worker-context init script prepended to every proxied dedicated,
shared and module worker script: WorkerNavigator surfaces
(userAgent, platform, language(s), hardwareConcurrency, deviceMemory),
the timezone and Intl patches, WebGL UNMASKED_* (the contexts exist
in workers through OffscreenCanvas), and the same deterministic
canvas perturbation on OffscreenCanvas convertToBlob /
transferToImageBitmap / the 2D context's getImageData, seeded
identically to the document pass, so a canvas fingerprint computed in
a worker matches the document's.

## Honest limits

- No per-session randomization by design: the default profile is a
  fixed fingerprint shared by every default-configured session.
- The timezone is a fixed offset, not a zone database: DST transitions
  inside a faked zone are not simulated, and
  `Date.prototype.toString` / `toTimeString` zone text still comes from
  the host's real locale setting.
- The worker/OffscreenCanvas pass (2.3) covers WorkerNavigator,
  Date/Intl timezone, WebGL UNMASKED_* and OffscreenCanvas 2D output;
  worker-side surfaces with no document counterpart (for example a
  worker's own `import.meta` or heap usage) stay native. The engine's
  own hands (the transport, the server) are outside a page's reach.
- The canvas perturbation is a small deterministic pixel nudge
  (seeded by `canvasSeed`), not a full canvas-noise engine; sites
  reading canvas output through other paths (e.g. `captureStream`)
  are not covered.
- WebGL spoofing covers `UNMASKED_VENDOR` / `UNMASKED_RENDERER` only;
  the rest of the GL parameter surface stays native, and GPU-side
  fingerprinting (shader timing, driver quirks) is out of scope.
- The engine does not carry a timezone database, so it cannot verify
  that `timezoneName` matches `utcOffsetMin`; the host is responsible
  for that pair being consistent.
