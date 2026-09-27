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

## ws:// upgraded to wss://

Insecure ws:// URLs are rewritten to wss:// before the transport sees
them (the upgrade decision is traced under subsystem websocket). No
plaintext WebSocket leaves the transport. Honest limit: targets that
serve WebSocket only without TLS will fail; this is deliberate.

## Semantics

- open / message / error / close events match the native constructor;
  readyState, url, protocol, binaryType (blob | arraybuffer),
  send(string | ArrayBuffer | TypedArray | Blob) and close(code).
- Text and binary frames both work; the transport handles RFC 6455
  framing, masking and fragmentation.
- Reconnecting libraries see normal error/close sequences and can
  reconnect as usual.
- Non-ws schemes fall through to the native constructor.

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

## Status

Implemented (1.3 Carbide). Honest limits: the bridge requires SW
control (a page outside the engine scope fails with error + close
1006, which matches native offline behavior); subprotocol and
extension negotiation follow libcurl; targets without TLS fail by
design (ws:// is upgraded).
