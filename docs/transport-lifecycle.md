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

The internal result contract distinguishes `definitely-not-delivered`,
`delivered-response`, and `delivery-unknown`, with the transport path and
original failure cause. Public fetch methods retain their Response/throw
contract. Failures retain their original cause inside a typed delivery error; relay
keeps its terminal unknown-delivery error behavior. A response means headers arrived; body
completion is separate.

Primary initialization runs before target dispatch and can establish
non-delivery. Once an adapter is called, all failures (including timeouts and
errors suggesting an unopened socket) remain delivery-unknown. Alternate
adapters initialize lazily while sending, so their failures remain unknown.
Relay no-channel/unsupported-body cases are pre-dispatch; channel failure or
invalid response after dispatch is unknown. Abort and one-shot bodies never
replay. Idempotent replay rules remain unchanged. Non-idempotent replay needs
engine-owned pre-dispatch evidence, stored privately rather than inferred
from error text or forgeable properties. Adapter-returned pre-dispatch classifications are reclassified as unknown;
mutable public error properties cannot change private replay evidence.

Fixed diagnostic messages record state and transport without copying error
messages, request bodies, tokens or URLs into this evidence log. Relay port
exceptions and invalid response construction cancel upstream and release
listeners; a broken cancellation port cannot block local teardown.

This is a safety contract, not proof of exactly-once delivery. Full server-side
fault injection at every acceptance boundary, including dropping a connection
after upstream commit, remains required before closing #454. Local adapter
fault tests and typed outcomes do not establish what a remote server committed.
