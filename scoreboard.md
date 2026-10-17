# Zeolite compat scoreboard

Generated: 2026-10-17T21:34:23.152Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 104ms | 93ms | 0.89x | 301/301 | - |  |
| reddit | PASS | 100ms | 62ms | 0.62x | 301/301 | - |  |
| wikipedia | PASS | 74ms | 85ms | 1.15x | 301/301 | - |  |
| github | PASS | 80ms | 90ms | 1.13x | 301/301 | - |  |
| discord | PASS | 116ms | 63ms | 0.54x | 301/301 | - |  |
| google-home | PASS | 75ms | 68ms | 0.91x | 200/200 | - |  |
| google-search | PASS | 1709ms | 1096ms | 0.64x | 200/200 | - |  |
| google-consent | PASS | 80ms | 77ms | 0.96x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
