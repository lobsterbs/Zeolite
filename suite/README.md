# Zeolite compat suite

Compat checks against a running zeolite-server. Runs in the scheduled
CI job (cron 0 3 * * *), on workflow_dispatch, and never on ordinary
pushes.

## Why this suite was rebuilt in 2.5 Iodide

The 1.9 Fullerene version of this suite was written against an HTTP
proxy surface that zeolite-server has never had. The server is a wisp
relay: exactly /wisp/ (WebSocket, wisp v2.1) plus a static-file
fallback. There is no /j/<b64url> route and there never was one; all
rewriting happens client-side in the service worker's wasm rewriters.
Because the compat job had never once completed before 2.5 (both prior
scheduled runs died on the rust job before compat executed), this went
unnoticed for six releases. The first run that ever executed
(36472949276, on 17d7615) proved it: every probe 404'd, and the
auto-filed issues #5-#9 were harness false alarms, not site failures.
The 2.5 suite drives the real surface: a wisp v2.1 session (wisp.mjs,
protocol per crates/wisp-core frame.rs / packet.rs / handshake.rs),
CONNECT per stream, raw HTTP/1.1 requests with Connection: close.

Rewriting fidelity is not observable from a node probe over TCP. It
stays covered where it lives: the app unit suite (vitest) and the wasm
job. The suite never claims it.

## probe.mjs - real-site probes

    node suite/probe.mjs --base http://localhost:6002

One wisp session, CONNECT to site:80 per site (YouTube, Reddit,
Wikipedia, GitHub, Discord), one raw HTTP/1.1 request per stream,
first-byte and total time, versus the same raw request over a direct
socket. Pass = the engine relayed a parseable status line whose class
matches the direct baseline. Writes scoreboard.json / scoreboard.md;
the compat job publishes them to the scoreboard branch. Report-only:
probe failures never gate the run (flaky external targets must not
break CI); the compat job opens one deduplicated issue per failing
site. Failures must become SiteConfig rules + a probe test, never a
hardcoded engine hack.

## capabilities.mjs - per-capability scoreboard

    node suite/capabilities.mjs --base http://localhost:6002

Gated rows over the real transport, deterministic against the local
fixture origin (fixtures.mjs): wisp-handshake, tcp-connect,
relay-response-bytes (body byte-identical to a direct socket request;
the Date header differs, so bodies only), relay-request-echo (POST
bytes relayed upstream and echoed), relay-media-bytes,
relay-download-bytes, relay-status-404, relay-status-500,
relay-redirect-301/302/307 (status + Location preserved; following is
the client's job), relay-set-cookie (Set-Cookie bytes preserved; jar
application is client-side). All fixture rows share one wisp session:
multiplexing streams over one connection is the point of the protocol.

Two extra servers are spawned from the repo-root
target/release/zeolite-server binary on fixed ports below the Linux
ephemeral range (runner outbound connections squat ports inside it
and the bind dies with AddrInUse), each verifying a
production-default behavior the main compat server cannot demonstrate
because it runs with the loopback escape hatch:

- port 16102, ssrf-private-blocked: started WITHOUT
  ZL_TEST_ALLOW_PRIVATE_DESTS, a loopback CONNECT must be refused with
  close reason 0x48 (BLOCKED) and no relayed bytes (policy.rs resolves
  DNS first and validates every address before connecting).
- port 16103, auth-required-refusal: started with
  ZL_WISP_USER/ZL_WISP_PASSWORD, a keyless v2 client must be refused
  during the handshake with close reason 0xc2 (AUTH_REQUIRED).

Gated rows fail the run (exit 1). Client-runtime capabilities
(html-links, opaque-urls, css-urls, iframe-src, js-serve, fetch-reroute,
websocket-bridge, worker-virtualization, storage-virtualization,
cache-api, client-cookie-jars, spa-routing) are honestly marked
client-runtime: a node probe cannot execute the service worker, so they
stay covered by the app unit suite + wasm job. Verdicts are facts,
never invented percentages.

## replay.mjs - recorded-session replay

    node suite/replay.mjs --base http://localhost:6002 \
      --session suite/sessions/fixture.session.json --fixture

Re-issues each recorded GET of a zlRecord session over wisp streams to
the %FIXTURE%-resolved host:port, follows 3xx Location hops manually
(bounded 8, same-origin; the SW follows redirects too, which is why
chains are recorded with final statuses), and compares the status
class. Bodies, headers and timings were never recorded (secrets,
size) and are not compared. The artifact contract is also checked:
ws events direction-only (known kinds, absolute ws(s):// targets,
never engine routes, never payloads) and cookie entries shape-only
(origin, name, domain, path; never values). A recording regression
(payload capture, value leak, route leak) fails replay instead of
shipping silently. Writes replay-report.json; any fail exits 1. See
docs/recording.md for how to record sessions with zl:recordStart /
zl:recordStop.

## Test-only SSRF escape hatch

The fixture origin is loopback, which the server's SSRF policy blocks
by default. The compat job starts the main server with
ZL_TEST_ALLOW_PRIVATE_DESTS=1 (crates/zeolite-server/src/policy.rs).
This is a test escape hatch only; the production default stays fully
locked down, and the ssrf-private-blocked row proves it on every run.
