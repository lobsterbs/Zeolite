# Zeolite capability scoreboard

Generated: 2026-10-03T20:15:15.615Z
Engine: http://localhost:6002 - wisp v2.1 transport - fixture: 127.0.0.1:42379

| capability | gate | status | notes |
| --- | --- | --- | --- |
| wisp-handshake | yes | PASS | v2.1 INFO exchange + CONTINUE(0) |
| tcp-connect | yes | PASS | 594 bytes relayed |
| relay-response-bytes | yes | PASS | body 458B byte-identical to direct |
| relay-request-echo | yes | PASS | request bytes relayed upstream and echoed |
| relay-media-bytes | yes | PASS | 14B binary body intact |
| relay-download-bytes | yes | PASS | attachment body intact |
| relay-status-404 | yes | PASS | status 404 |
| relay-status-500 | yes | PASS | status 500 |
| relay-redirect-301 | yes | PASS | status 301 + Location preserved |
| relay-redirect-302 | yes | PASS | status 302 + Location preserved |
| relay-redirect-307 | yes | PASS | status 307 + Location preserved |
| relay-set-cookie | yes | PASS | upstream Set-Cookie bytes preserved (jar application is client-side) |
| ssrf-private-blocked | yes | PASS | loopback CONNECT refused with reason 0x48 |
| auth-required-refusal | yes | PASS | keyless v2 handshake refused with reason 0xc2 |
| html-links | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| opaque-urls | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| css-urls | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| iframe-src | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| js-serve | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| fetch-reroute | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| websocket-bridge | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| worker-virtualization | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| storage-virtualization | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| cache-api | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| client-cookie-jars | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |
| spa-routing | report | CLIENT-RUNTIME | lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp |

Gated capabilities fail the run; report-only ones surface reality without gating.
Client-runtime rows live in the SW/wasm client runtime (no browser in CI):
they are covered by the app unit suite and the wasm job, not probed here.
