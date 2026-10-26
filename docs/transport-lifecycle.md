# Transport lifecycle

The wisp WebSocket lifecycle is owned by the vendored transport adapters in
`app/src/libcurl-transport-vendored.ts`, not by the service worker. When the
socket dies, the proactive watcher installed at module evaluation resets the
transport singletons and re-inits with backoff (`reconnectDelay`, 1s doubling,
60s ceiling), so the next request finds a live transport. The request-time
retry in the service worker (connect-class errors) remains the backstop for
mid-stream failures.

#119 closed the observational-only gap: an explicit lifecycle machine
(app/src/transport-lifecycle.ts, states idle / connecting / connected /
dead) is driven by the seams that observe the transport - vendored
init(), the watcher socket open/close events, and reset() - and every
transition reaches DIAG. The request path consults the machine: a
fetch that arrives while the transport is known-dead waits (bounded,
10s) for the reconnect instead of racing it; a timeout is not an
error, the normal path and its honest failure still run. The watcher
stays as a fallback for transports that cannot report, and the
connect-class reset+retry remains the backstop for mid-stream
failures.

Frame-buster neutralization (`crates/rewriter/src/js/antiframe.rs`) is
wired into the streaming rewriter for both script bodies and inline
event handlers, at feature parity with the sibling server-side pass.
Its unit tests run under the rust CI job's `cargo test` step.

## Replay and relay bounds

Transport error messages do not prove non-delivery. After dispatch, automatic retries require an idempotent method and a replayable body; POST/PATCH failures remain terminal even when their text describes an unopened WebSocket. This intentionally favors avoiding duplicated side effects.

Relay credit negotiation is captured per request. Replacing the registered port cannot change the credit protocol of existing streams. Pending response queues are bounded to 4 MiB and 4,096 frames, including legacy peers. Overflow cancels upstream and fails the response; it never silently drops body bytes. Legacy peers still lack cooperative backpressure.

## Explicit delivery evidence (#454)

The transport seam now represents request-delivery confidence as three typed
states in `app/src/delivery.ts`:

- `definitely-not-delivered`: a verified failure **before** the transport
  adapter was invoked (e.g. primary Wisp initialization failure).
- `delivered-response`: an actual response was received.
- `delivery-unknown`: an adapter was invoked but failed, timed out or lost
  its channel before a response; error text does **not** prove non-delivery.

Wisp and alternate-Wisp failures after dispatch surface typed
`TransportDeliveryError` errors, and the relay's existing terminal
`RelayDeliveryUnknownError` now carries the same explicit delivery state and
its transport identity. Generic untyped adapter errors default to
`delivery-unknown`. The retry gate requires a replayable body AND either an
idempotent method or **verified** pre-dispatch non-delivery. Caller aborts
remain aborts rather than delivery-inference candidates. A synchronous relay
`MessagePort.postMessage` error cleans up its waiter and abort listener,
then conservatively treats delivery as unknown.

This is a safety contract, **not proof of exactly-once delivery**: network
failures after dispatch cannot generally establish whether the upstream
committed a write. The contract is in use at the current Wisp/relay seams,
but full fault-injection coverage at every server-side acceptance boundary,
including drop-after-upstream-commit, is still required before closing #454.
