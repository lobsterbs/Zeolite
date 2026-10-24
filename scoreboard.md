# Zeolite compat scoreboard

Generated: 2026-10-24T15:20:27.730Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 63ms | 63ms | 1x | 301/301 | - |  |
| reddit | PASS | 13ms | 45ms | 3.46x | 301/301 | - |  |
| wikipedia | PASS | 55ms | 59ms | 1.07x | 301/301 | - |  |
| github | PASS | 35ms | 60ms | 1.71x | 301/301 | - |  |
| discord | PASS | 44ms | 45ms | 1.02x | 301/301 | - |  |
| google-home | PASS | 52ms | 50ms | 0.96x | 200/200 | - |  |
| google-search | PASS | 1739ms | 882ms | 0.51x | 200/200 | - |  |
| google-consent | PASS | 45ms | 85ms | 1.89x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
