# Zeolite compat scoreboard

Generated: 2026-11-01T21:34:53.161Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 90ms | 113ms | 1.26x | 301/301 | - |  |
| reddit | PASS | 13ms | 52ms | 4x | 301/301 | - |  |
| wikipedia | PASS | 9ms | 55ms | 6.11x | 301/301 | - |  |
| github | PASS | 41ms | 68ms | 1.66x | 301/301 | - |  |
| discord | PASS | 13ms | 53ms | 4.08x | 301/301 | - |  |
| google-home | PASS | 63ms | 56ms | 0.89x | 200/200 | - |  |
| google-search | PASS | 1889ms | 1349ms | 0.71x | 200/200 | - |  |
| google-consent | PASS | 50ms | 197ms | 3.94x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
