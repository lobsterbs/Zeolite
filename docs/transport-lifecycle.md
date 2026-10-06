# Transport lifecycle

The wisp WebSocket lifecycle is owned by the vendored transport adapters in
`app/src/libcurl-transport-vendored.ts`, not by the service worker. When the
socket dies, the proactive watcher installed at module evaluation resets the
transport singletons and re-inits with backoff (`reconnectDelay`, 1s doubling,
60s ceiling), so the next request finds a live transport. The request-time
retry in the service worker (connect-class errors) remains the backstop for
mid-stream failures.

Known gap, kept honest: the watcher is observational only. A request
that lands in the sub-second window between socket death and the first
reconnect attempt fails honestly; it does not wait.

Frame-buster neutralization (`crates/rewriter/src/js/antiframe.rs`) is
wired into the streaming rewriter for both script bodies and inline
event handlers, at feature parity with the sibling server-side pass.
Its unit tests run under the rust CI job's `cargo test` step.
