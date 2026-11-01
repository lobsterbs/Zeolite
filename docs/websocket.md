# Zeolite WebSocket (Phase 3, 1.3 Carbide)

Pages reach proxied WebSocket servers through the service worker. The
SW cannot intercept WebSocket upgrades, so the runtime bootstrap
replaces the page's WebSocket constructor with a shim that posts a
zl:wsOpen control message (with a dedicated MessageChannel port) to the
controlling SW. The SW opens the real connection through the vendored
libcurl transport and relays events over that port for the lifetime of
the connection.

## Where TLS lives

The service worker cannot terminate TLS. The bridge therefore uses
LibcurlClient.connect (verified in the vendored dist v2.0.5): libcurl
performs the real TLS handshake and the ws handshake over a raw wisp
TCP stream, the same proven path proxied HTTPS uses. The previous
in-page raw-stream implementation (RFC 6455 framing by hand in the
bootstrap) was removed: it could speak only plaintext, so wss://
destinations never actually worked.

## ws:// passes through as written (since #525)

Plaintext ws:// URLs are dialed as plaintext: no scheme upgrade exists
anymore. The old force-upgrade to wss:// sent a TLS ClientHello to
every plaintext-ws origin (an http-only origin cannot answer it, the
handshake never settles and the page socket stalls), while cleartext
http already rides the same wisp tunnel - so #525 removed the upgrade
and passes ws:// through, traced under subsystem websocket with the
rule "plaintext". Plaintext-only WebSocket servers therefore work.
There is no configuration surface and no fallback: the URL the page
wrote is the URL the transport dials (retargeted engine-side through
the sender's virtual context, never re-schemed).

## Semantics

- open / message / error / close events match the native constructor;
  readyState, url, protocol, binaryType (blob | arraybuffer),
  send(string | ArrayBuffer | TypedArray | Blob) and close(code).
- Text and binary frames both work; the transport handles RFC 6455
  framing, masking and fragmentation.
- Reconnecting libraries see normal error/close sequences and can
  reconnect as usual.
- `bufferedAmount` (#462) counts UTF-8 text and binary payload bytes
  while page/worker messages await acceptance at the service-worker
  bridge. The bridge sends a byte-count acknowledgment only after its
  transport `send()` succeeds; failed writes receive no acknowledgment.
  This is deliberately **bridge-queue accounting**, not an assertion
  that data reached the peer or left the underlying TLS/Wisp buffer.
  Sends discarded in CLOSING/CLOSED still add their payload bytes, matching
  Chromium. Those discarded bytes receive no bridge acknowledgment.
  Network-level bufferedAmount parity requires transport drain signals
  that the current WsHandle does not expose.
- Non-ws schemes fall through to the native constructor.

## URL handling (#279)

The page-side constructor applies the native WebSocket URL semantics,
with one deliberate extension:

- The argument is resolved against the calling realm's base
  (document.baseURI, falling back to location.href) before the
  scheme check, so relative references such as
  new WebSocket("/socket") or new WebSocket("api/ws") work the way a
  same-origin site expects. The native constructor requires an
  absolute URL; the engine accepts the relative form because every
  proxied page lives on the engine origin and relative endpoints
  are the common real-world pattern.
- http: maps to ws: and https: maps to wss: (the WHATWG constructor
  rule), so a page that builds its endpoint from location.protocol
  connects through the bridge instead of failing.
- A URL with a fragment is refused with SyntaxError, matching the
  native constructor.
- Any scheme other than ws/wss (after the http/https mapping) falls
  through to the native constructor, which refuses it.

An engine-host ws URL carries no destination by itself. The worker
recognizes it by host equality (a ws/wss origin carries its scheme
and can never equal the worker's https origin) and retargets it
through the sender's own virtual context: a routed ws literal or a
handle (NAVH) ws URL decodes to its true destination through the
full client decode, so the path resolves exactly; everything else
retargets at the origin level. The page-visible ws.url property
reports the engine-origin URL as resolved, never the target.

## Why simple URL rewriting cannot carry WebSocket traffic

WebSocket upgrades are not requests the engine origin could serve:
the browser hands the upgrade directly to the server named in the
URL, service worker interception does not exist for that class,
and the engine origin runs no WebSocket handler. Rewriting a ws://
literal to an engine route and leaving it there would therefore
produce a direct connection attempt at the engine origin that
always fails. The engine instead treats routed ws literals as
tokens to be decoded: the bootstrap constructor shim owns the
routing, every ws(s) construction is bridged through zl:wsOpen,
the worker opens the real connection through the wisp transport
(TLS terminated at libcurl, see above), and events relay over the
dedicated port. Whether proxied WebSocket traffic is allowed stays
a deployment policy decision: the transport is the same single
path as every other request, so there is deliberately no separate
WebSocket policy surface.

## Inspector

Each connection produces two network-log rows: one at open (status
101, verdict ws) and one at close (final close code, total rx/tx
bytes, verdict ws:closed or ws:aborted, error detail on abnormal
close). Per-message records (open, tx, rx, close, upgrade) land in the
opt-in tracing ring (subsystem websocket) when tracing is enabled.
Abnormal closes also land in the diagnostics feed (category
WEBSOCKET). Per-message rows are deliberately not added to the
bounded network ring.

## Cleanup

The bridge registry holds only live connections: entries are dropped
at close, at error-before-open, and at zl:teardown (every live
connection is closed and forgotten before the SW unregisters).

## WebRTC is unavailable (#544)

WebRTC is not proxied and not faked: the bootstrap navguard deletes
`RTCPeerConnection` outright (plus its prefixed aliases), so the exact
failure mode is a plain constructor absence - a `ReferenceError`/
`TypeError` at construction, never a half-working object, never a
silent fallback onto another transport. The reason is egress honesty:
ICE/STUN negotiates direct browser-to-peer UDP paths that bypass the
service worker and the engine transport entirely, so a constructible
WebRTC API would leak real connection metadata and traffic around the
proxy. Hosts detect this state via the `zl:ping` capability report
(`webrtc: "unavailable"`, `websocket: "native-bridge" | "relay"`,
`websocketPlaintext: true`, `replaySpool: <live zl:config choice>`);
a report of "unavailable" means designed absence, not breakage.

## Status

Implemented (1.3 Carbide). Honest limits: the bridge requires SW
control (a page outside the engine scope fails with error + close
1006, which matches native offline behavior); subprotocol and
extension negotiation follow libcurl; plaintext ws:// targets are
dialed as plaintext since #525 (no upgrade, no TLS fallback).

Synchronous transport send failures terminate the bridge connection (#485).
The page receives an error followed by an abnormal 1006 close; the bridge
detaches the connection before closing the transport, so a reentrant close
callback cannot report it twice. Failed sends are not counted as transmitted.
