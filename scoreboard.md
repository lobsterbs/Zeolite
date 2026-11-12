# Zeolite compat scoreboard

Generated: 2026-11-12T12:36:53.449Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 84ms | 80ms | 0.95x | 301/301 | - |  |
| reddit | PASS | 55ms | 52ms | 0.95x | 301/301 | - |  |
| wikipedia | PASS | 53ms | 72ms | 1.36x | 301/301 | - |  |
| github | PASS | 17ms | 48ms | 2.82x | 301/301 | - |  |
| discord | PASS | 48ms | 51ms | 1.06x | 301/301 | - |  |
| google-home | PASS | 65ms | 67ms | 1.03x | 200/200 | - |  |
| google-search | PASS | 1836ms | 1838ms | 1x | 200/200 | - |  |
| google-consent | PASS | 103ms | 61ms | 0.59x | 404/404 | - |  |

## consent.google.com redirect chain (issue #79, report-only)

- consent.google.com/: status 404, set-cookie x1

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
