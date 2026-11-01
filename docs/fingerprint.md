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
- `matchUserAgent` - boolean, defaults to `true`: the chosen UA owns document
  and worker UA/appVersion/platform/userAgentData and upstream UA/Client Hints.
  Set `false` to retain native identity while independent profile controls
  (languages, timezone, canvas) remain enabled. This does not change TLS.
- `platform` - derived from the UA when omitted (`Win32` for Windows
  NT, `MacIntel` for Mac, `Linux armv8l` for Android, ...). An explicit
  value that contradicts the UA is rejected.
- `languages` - array shown as `navigator.language` / `languages` and
  sent upstream as `Accept-Language`.
- `utcOffsetMin` - minutes ahead of UTC (Oslo summer: 120). Patches
  `Date.prototype.getTimezoneOffset` and the local Date getters as a
  fixed offset, and since #540 also formats the `Date.toString` /
  `toTimeString` zone text from that offset (Chromium's Etc/GMT shape,
  e.g. `GMT+0200 (GMT+02:00)`); `toJSON` stays the UTC ISO form, exactly
  like real Chromium in every zone. When `timezoneName` is not set, the
  Intl default zone becomes the canonical identity derived from this
  offset: a real IANA `Etc/GMT` zone (note IANA's inverted sign:
  UTC+5 is `Etc/GMT-5`), or an offset string like `+05:30` for
  non-whole-hour offsets.
- `timezoneName` - IANA zone name patched into `Intl.DateTimeFormat`.
  #540: when the name is an `Etc/GMT` zone it is checked against
  `utcOffsetMin` (sign-mapped); a contradiction keeps the explicit
  name (user input is never silently rewritten) and records it on the
  resolved profile as `timezoneInconsistent: true`. Non-Etc names
  cannot be verified without a tz database and are deliberately not
  checked; an explicit name always wins over the derived one.
- `hardwareConcurrency`, `deviceMemoryGB` - navigator surfaces.
- `screen` - `{ width, height, availWidth, availHeight, colorDepth,
  pixelDepth }` for `window.screen`.
- `webglVendor`, `webglRenderer` - the UNMASKED_VENDOR /
  UNMASKED_RENDERER strings; both or neither.
- `canvasSeed` - deterministic seed for canvas perturbation.
- `engines` - optional engine binding: which transport engines
  (`"libcurl"`, `"epoxy"`) the profile is valid for. Applying a
  profile while the live engine (the `zl:transport` poll reports it)
  is not in the list is refused with that reason, never silently
  applied; omitted means valid for both. The TLS fingerprint itself
  never comes from the profile (see the last section).

The default profile (used when the host asks for the default rather
than supplying one) is a coherent Chrome-on-Windows desktop.

## What is spoofed and where

The service worker compiles the profile into an init script once and
prepends it to the `window.__ZL` init chunk it already emits at the
start of every rewritten HTML document. Engine-initiated upstream
requests carry the profile `User-Agent` and `Accept-Language`, so the
document surface and the wire surface agree. UA data is patched on the
browser's existing NavigatorUAData object in documents and workers; the API
is not created in browsers without it. A non-Chromium profile exposes no
Chromium UA data. Low-entropy brand/mobile/platform values share the same
source as upstream headers. Four-part versions explicitly in the UA supply
full-version fields (the UA version itself may be reduced); explicit CPU
markers supply architecture/bitness. Unknown platform-version/model and
other unsupported high-entropy fields are omitted, never copied from the
physical host. High-entropy request headers are regenerated only when
originally present; no unsolicited device hints are added. Native high
entropy remains unchanged when matching is disabled or no identity changes.

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

- UA-data patches do not recreate every native property descriptor or hide
  the physical browser engine. Unsupported high-entropy fields stay absent.
- No per-session randomization by design: the default profile is a
  fixed fingerprint shared by every default-configured session.
- The timezone contract is deliberately NARROW (#540): a
  self-consistent fixed offset expressed through real IANA `Etc/GMT`
  zones (or Intl offset strings for half-hour offsets), so Date and
  Intl agree everywhere without a timezone database. Etc/GMT zones
  never observe DST: a profile cannot claim `America/New_York`-style
  DST behavior, and the fixed offset deliberately does not shift
  across real DST boundaries. An explicit non-Etc `timezoneName` is
  applied to Intl as given but cannot be verified against the offset;
  if it contradicts an Etc name/offset pair that CAN be checked, the
  conflict is recorded (`timezoneInconsistent`), never silently fixed.
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
  that a non-Etc `timezoneName` matches `utcOffsetMin`; the host is
  responsible for that pair being consistent. What the engine CAN
  verify without a database - the `Etc/GMT` sign mapping - it does
  check since #540, recording (not fixing) contradictions.
- The complete list of what the profile controls - and what stays
  native or transport-owned - is the versioned inventory in
  `docs/fingerprint-surfaces.md` (schemaVersion 1).

## Transport engine binding

Since the selectable second engine (#64), the TLS handshake
fingerprint is a property of the transport engine, not a profile
field: libcurl terminates TLS through libcurl.js (mbedTLS), epoxy
through rustls + hyper. A FingerprintProfile never rewrites the TLS
handshake (JA3/JA4, ALPN, HTTP/2 SETTINGS); no profile field can, by
design, because the engine is the only component that terminates
TLS. What does flow from the profile on both engines, per request
and identically: the profile `User-Agent` and the `languages`-
derived `Accept-Language`. Switching engines (the `zl:transport`
control message, or the deployment `ZL_TRANSPORT` define) changes
the direct transport's handshake fingerprint. A policy route served through
an embedder relay uses that embedder's independent TLS/HTTP2 client; changing
a device profile does not reconfigure it. UA consistency does not guarantee
browser-identical TLS or CAPTCHA acceptance. A profile can bind
itself to specific engines with the `engines` field; under an
unlisted engine `zl:fingerprint` refuses with the reason instead of
silently applying. This validates the selected direct engine, not the
embedder relay's independent persona. Measured JA3 values per engine are pending a
parity run; none are invented here.

## Detectability surfaces (#141)

navigator.serviceWorker: a proxied page sees the engine's
controlling worker (controller, getRegistration) and honestly so.
Registration state is shared browser state a page shim cannot
keep consistent, and faking it adds its own detection surface;
documented limit, not patched.

AudioContext: profiles may set audioNoise (default off). When on,
AnalyserNode float/byte frequency reads carry deterministic noise
seeded from canvasSeed, so one profile always yields one surface
and the surface coheres with the active UA profile instead of
adding a mismatched-pair signal.

WebGL: UNMASKED_VENDOR/RENDERER come from the profile (ANGLE
strings paired with the UA), shipped since 1.8 Telluride.

TLS fingerprint: unchanged by device profiles by design; the
blocked-host class is served by the embedder relay (#137, policy
route "relay"), and JA3/H2 profiles remain the transport-side
work tracked in the fingerprint transport binding.

Timing: the transport adds latency; the engine documents rather
than smooths it. Route strings stay opaque since #32.