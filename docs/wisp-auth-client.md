# Wisp password-auth client (#496)

The service worker's wisp transport can now carry wisp v2.1
PasswordAuth credentials against a zeolite-server that sets
`ZL_WISP_USER` / `ZL_WISP_PASSWORD`. The credentials never leave the
worker's memory and never appear in URLs, subprotocols, diagnostics or
control replies.

## Host surface

- `zl:wispAuth` (host-only, never accepted from proxied pages):
  `{ type: "zl:wispAuth", wispAuth: { op: "set", endpoint, username, password } }`
  arms the client; `{ op: "clear" }` disarms it. The reply is the redacted
  status: mode, endpoint (origin + pathname), secure, lastOutcome.
- `zl:ping` carries the same redacted `wispAuth` block.

Rules, fail-closed:

- Credentials are memory-only. A worker restart drops them; the host
  re-pushes after `controllerchange` or on boot. This is by design:
  no secret ever hits IndexedDB or the cache.
- `wss://` is required everywhere except loopback `ws://` (local
  test fixtures). The status reports `secure: false` honestly for
  loopback.
- The endpoint is matched on origin + pathname. The engine's own
  `?zlgen` cache-bust query (see #133) does not defeat the match.
- A credentialed socket that cannot finish an authenticated v2
  handshake within 10 s is closed with outcome
  `auth-unsupported`. No silent unauthenticated downgrade.

Server close reasons map to stable outcomes: 0xc0
`invalid-credential`, 0xc2 `auth-required`, 0xc1 `auth-unsupported`.
Repeated stall + reset cycles with `lastOutcome: null` mean the
handshake succeeded and the problem is elsewhere.

## The adapter seam and its two modes

The shipped wisp client lives inside the vendored
libcurl-transport bundle and is never forked. It creates its wisp
WebSocket through the worker scope's `WebSocket` constructor, the same
seam the #74 wisp watcher wraps, and it opens streams with wisp v1
CONNECT packets. `installWispAuthSocket()` (called after the watcher,
so the auth wrapper is outermost) subclasses that constructor:

1. v1 upgrade (both shipped engines): the caller passed no
   subprotocol, so the wrapper appends `"wisp"` to negotiate v2,
   answers the server's opening INFO itself with a PasswordAuth
   client INFO, holds every vendor frame until the server's
   handshake CONTINUE, then releases them in order with CONNECTs
   translated from the v1 to the v2 hostname layout (the only wire
   difference: a u8 host length prefix). The handshake frames
   propagate to the vendor: its v1 state machine tolerates them (an
   unknown INFO type is a warning, a stream-0 CONTINUE sets its
   send buffer size) and it flips connected on its first message,
   which is what unblocks the engine's stream creation. The vendor's
   v1 flow has no CONTINUE frames, so the wrapper also grants the
   v2 server per-stream send credits on the vendor's behalf
   (zeolite-server spends one credit per DATA packet and without
   client CONTINUE credits it relays no DATA at all), topping the
   window up at half.
2. v2 native (a future vendor that requests `"wisp"` itself): the
   wrapper rewrites only the first outgoing frame when it is a
   decodable v2 client INFO, preserving the vendor's own extensions
   and appending PasswordAuth; everything else passes untouched.

The unit suite pins the codec byte-exactly and the wrapper state
machine on a fake WebSocket; `suite/e2e/wisp-auth.mjs` is the live
probe (real zeolite-server with auth env, real chromium SW): raw
no-credential and wrong-credential refusals, credential set without
secret echo, transport re-init, a proxied fixture page rendering
through the authenticated session, and the redacted afterwards ping.

## Honest gaps

- No worker-restart persistence: by design, the host re-pushes.
- The live probe covers loopback `ws://`; production `wss://` is
  enforced by rule but not probed here.
- A v1-only server (no INFO) on a credentialed endpoint fails closed
  as `auth-unsupported`; that is the correct behavior, not a gap.
