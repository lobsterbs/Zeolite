# Transport lifecycle

## Wisp socket watcher (engine #74 follow-up)

The wasm transports (libcurl, epoxy) own the browser WebSocket to the
wisp endpoint and do not surface its lifecycle. `app/src/libcurl-transport-vendored.ts`
wraps the scope's WebSocket constructor at module evaluation
(`installWispWatcher`) and observes every socket whose URL matches the
endpoint of the last `init()` config. When the last live wisp socket
closes, the transport singletons are dropped and a proactive re-init runs
with capped exponential backoff (1s doubling, 60s ceiling,
`reconnectDelay`), so the next request finds a live transport. The
request-time retry in the service worker (connect-class errors) remains
the backstop for mid-stream failures.

Known gap, kept honest: the watcher is observational only. A request
that lands in the sub-second window between socket death and the first
reconnect attempt fails honestly; it does not wait.

Verification note (2026-10-05): CI runner availability on this account is throttled; cancelled runs with no executed steps are queue cancels, not code failures. One retrigger once runners free up is the correct response.
