# Zeolite compat scoreboard

Generated: 2026-11-28T18:16:37.222Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 92ms | 103ms | 1.12x | 301/301 | - |  |
| reddit | PASS | 17ms | 54ms | 3.18x | 301/301 | - |  |
| wikipedia | PASS | 45ms | 68ms | 1.51x | 301/301 | - |  |
| github | PASS | 30ms | 61ms | 2.03x | 301/301 | - |  |
| discord | PASS | 23ms | 53ms | 2.3x | 301/301 | - |  |
| google-home | PASS | 63ms | 63ms | 1x | 200/200 | - |  |
| google-search | PASS | 1606ms | 1091ms | 0.68x | 200/200 | - |  |
| google-consent | PASS | 76ms | 37ms | 0.49x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
