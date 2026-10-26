# WISP v2.1 client authentication — #496 implementation boundary

Zeolite's standalone server already supports password (INFO extension
0x02) and key (INFO extension 0x03) authentication. The production
browser transport currently runs through **vendored libcurl-transport
2.0.5 or Epoxy** with a configured WebSocket URL. Their actual
WISP INFO-frame construction and credential-extension seam has not
been shown to accept host-owned auth material.

## Newly implemented, but NOT yet used by the vendored transport

`crates/wisp-wasm/src/lib.rs` now exports
`handshakeInfoPassword(username, password)`. This creates a WISP
v2 INFO packet using `wisp_core::extension::password_auth_client`
and the common packet encoder. It fails closed for missing or
oversized credentials, returns no log, never encodes a secret in
the WebSocket URL or subprotocol, and has unit tests that parse the
generated INFO frame through the canonical WISP decoder.

**This alone does not authenticate Zeolite's HTTP/WebSocket traffic.**
The vended libcurl/Epoxy clients own their own live WISP sessions,
and do not call the Zeolite `wisp-wasm` helper. Do not claim a
credentialed `/wisp/` deployment works, do not enable a runtime
password picker, and do not silently downgrade to unauthenticated
WISP endpoints.

## Required verified production integration (open)

1. Audit the exact pinned vendored client source: locate and test the
   real WISP v2 client INFO serialization and server INFO extension
   negotiation. Confirm whether it already exposes password/key auth
   hooks; if it does not, port/fork or extend the vendor WISP layer
   instead of using unsafe `WebSocket.send` interception.
2. Pass an ephemeral credential capability through a **host-only**
   control plane. Credentials are neither URL params nor ordinary
   `zl:config` fields and must not persist in localStorage, Cache
   API, tracing, KDL, diagnostics, or host-page-readable shims.
3. Check server INFO requirements **before** sending credentials,
   prevent endpoint-reuse credential confusion, never downgrade
   after auth was required, and enforce WSS. Ensure disconnect,
   worker teardown and endpoint switching clear credentials.
4. Run a real Chromium -> authenticated `zeolite-server` fixture:
   good password -> WISP handshake + HTTP fetch + WebSocket stream;
   wrong/missing password -> explicit rejection; worker restart
   and transport reconnection; endpoint switching and TLS failure.
   Repeat key authentication only after verifying an actual Ed25519
   signing seam in the production client.

No username/password, signing key or sensitive handshake frames are
exposed in `zl:doctor`, `zl:exportDiagnostics`, KDL or MCP.

Until these checks pass, #496 remains **partially implemented** and
the integration guide's limitation about authenticated WASM client
traffic remains accurate.
