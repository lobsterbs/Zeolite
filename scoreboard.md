# Zeolite compat scoreboard

Generated: 2026-10-31T16:29:48.527Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 106ms | 125ms | 1.18x | 301/301 | - |  |
| reddit | PASS | 81ms | 70ms | 0.86x | 301/301 | - |  |
| wikipedia | PASS | 190ms | 67ms | 0.35x | 301/301 | - |  |
| github | PASS | 78ms | 91ms | 1.17x | 301/301 | - |  |
| discord | PASS | 47ms | 71ms | 1.51x | 301/301 | - |  |
| google-home | PASS | 69ms | 75ms | 1.09x | 200/200 | - |  |
| google-search | PASS | 1041ms | 620ms | 0.6x | 200/200 | - |  |
| google-consent | PASS | 68ms | 66ms | 0.97x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
