# Zeolite compat scoreboard

Generated: 2026-11-21T12:09:13.219Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 29ms | 91ms | 3.14x | 301/301 | - |  |
| reddit | PASS | 10ms | 46ms | 4.6x | 301/301 | - |  |
| wikipedia | PASS | 6ms | 44ms | 7.33x | 301/301 | - |  |
| github | PASS | 7ms | 45ms | 6.43x | 301/301 | - |  |
| discord | PASS | 10ms | 45ms | 4.5x | 301/301 | - |  |
| google-home | PASS | 45ms | 42ms | 0.93x | 200/200 | - |  |
| google-search | PASS | 1803ms | 1282ms | 0.71x | 200/200 | - |  |
| google-consent | PASS | 73ms | 66ms | 0.9x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
