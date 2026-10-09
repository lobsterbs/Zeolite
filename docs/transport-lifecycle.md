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
