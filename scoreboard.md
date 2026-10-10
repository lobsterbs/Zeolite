# Zeolite compat scoreboard

Generated: 2026-10-10T21:09:43.301Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 126ms | 129ms | 1.02x | 301/301 | - |  |
| reddit | PASS | 25ms | 59ms | 2.36x | 301/301 | - |  |
| wikipedia | PASS | 106ms | 67ms | 0.63x | 301/301 | - |  |
| github | PASS | 103ms | 88ms | 0.85x | 301/301 | - |  |
| discord | PASS | 36ms | 59ms | 1.64x | 301/301 | - |  |
| google-home | PASS | 45ms | 53ms | 1.18x | 200/200 | - |  |
| google-search | PASS | 44ms | 1753ms | 39.84x | 200/200 | - |  |
| google-consent | PASS | 77ms | 185ms | 2.4x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
