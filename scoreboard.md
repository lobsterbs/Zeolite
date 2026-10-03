# Zeolite compat scoreboard

Generated: 2026-10-03T20:15:14.659Z
Engine: http://localhost:6002 - wisp v2.1 transport, raw HTTP/1.1 on port 80

| site | status | ttfb direct | ttfb proxy | ratio | status d/p | notes |
| --- | --- | --- | --- | --- | --- | --- |
| youtube | PASS | 43ms | 28ms | 0.65x | 301/301 |  |
| reddit | PASS | 11ms | 10ms | 0.91x | 301/301 |  |
| wikipedia | PASS | 6ms | 4ms | 0.67x | 301/301 |  |
| github | PASS | 6ms | 9ms | 1.5x | 301/301 |  |
| discord | PASS | 11ms | 16ms | 1.45x | 301/301 |  |

Report-only since 2.5 Iodide: failures open issues, they never gate
(flaky external targets must not break CI).
