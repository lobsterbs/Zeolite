# Network inspector (Phase 4)

`/devtools.html` on the engine origin is the network inspector page.
It is served by the engine and controlled by the same service worker,
so it talks to the engine through the SW control plane.

## How it works

1. The SW keeps a fixed-size ring buffer (256 entries) of every proxied
   request: timestamp, method, engine-local path, real destination,
   status, time-to-response-headers in ms, and the error string when
   the upstream fetch failed. Cross-origin passthroughs the engine
   declines are logged too (status 0, verdict "passthrough:
   cross-origin", transport "browser"): they are the observable
   escape class from issue #28, not proxied traffic.
2. The page polls `{ type: "zl:getNetLog" }` once per second over a
   MessageChannel and renders a sortable table. Polling (not push) is
   deliberate: no extra SW message fan-out, and a page that sleeps
   simply skips updates.
3. Column headers sort; click again to reverse. Errors are red, status
   classes are color-coded by first digit.

## Limits

- The log is in-memory only: it resets when the SW is reclaimed. It is
  a debugging surface, not telemetry.
- Timing is time-to-response-headers, not full body download.
- Bodies are not captured (the rewriter streams them; buffering them
  for the inspector would cost first paint).
- A DOM/CSS inspector (postMessage bridge into proxied pages,
  CDP-style subset) is the stretch goal and not built yet.
