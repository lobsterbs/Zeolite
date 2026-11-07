# Zeolite compat scoreboard

Generated: 2026-11-07T17:55:44.933Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 68ms | 82ms | 1.21x | 301/301 | - |  |
| reddit | PASS | 52ms | 51ms | 0.98x | 301/301 | - |  |
| wikipedia | PASS | 24ms | 52ms | 2.17x | 301/301 | - |  |
| github | PASS | 14ms | 52ms | 3.71x | 301/301 | - |  |
| discord | PASS | 22ms | 51ms | 2.32x | 301/301 | - |  |
| google-home | PASS | 54ms | 58ms | 1.07x | 200/200 | - |  |
| google-search | PASS | 1388ms | 4073ms | 2.93x | 200/200 | - |  |
| google-consent | PASS | 47ms | 35ms | 0.74x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
