# Zeolite compat suite

Nightly compatibility checks against a running Zeolite engine. Runs in
the scheduled CI job only (cron 0 3 * * *), never on ordinary pushes.

## probe.mjs - real-site probes

    node suite/probe.mjs --base http://localhost:6002

Measures time-to-first-byte through the engine versus direct for a
fixed site list (YouTube, Reddit, Wikipedia, GitHub, Discord) and
records failing subresources. Writes scoreboard.json / scoreboard.md;
the CI publishes them to the scoreboard branch. The Phase 1 gate:
YouTube + Reddit pass with first-paint ratio <= 2x. Failures must
become SiteConfig rules + a probe test, never a hardcoded engine hack.

## capabilities.mjs - per-capability scoreboard (1.9 Fullerene)

    node suite/capabilities.mjs --base http://localhost:6002

Probes individual engine capabilities (HTML link rewriting, opaque
URLs, CSS url(), JS serving, fetch GET/POST, iframes, 301/302/307
redirects, downloads, media bytes, error statuses, server Set-Cookie)
against a deterministic local fixture origin (fixtures.mjs, a tiny
node:http server on 127.0.0.1 with byte-stable responses). Writes
capabilities.json / capabilities.md. Verdicts are facts, never invented
percentages. Only proven-safe capabilities gate the run; the rest are
report-only. Client-runtime capabilities (WebSocket bridge, worker
virtualization, storage, Cache API, client cookie jars, SPA routing)
are honestly marked client-runtime: a plain HTTP probe cannot execute
page JavaScript, so they stay covered by the app unit suite and session
recording.

## replay.mjs - recorded-session replay (1.9 Fullerene)

    node suite/replay.mjs --base http://localhost:6002 \
      --session suite/sessions/fixture.session.json --fixture

Re-issues the destination URLs of a recorded zlRecord session through
the engine and compares the stable facts only (reachability, status
class, unrewritten-URL absence for HTML). Bodies, headers and timings
were never recorded and are not compared. The checked-in fixture
session uses a %FIXTURE% token, resolved to a live fixture port at
replay time so it stays port-independent. Writes replay-report.json;
any fail exits 1. See docs/recording.md for how to record sessions
with zl:recordStart / zl:recordStop.

## Test-only SSRF escape hatch

The fixture origin is loopback, which the server's SSRF policy blocks
by default. The nightly job starts zeolite-server with
ZL_TEST_ALLOW_PRIVATE_DESTS=1 (crates/zeolite-server/src/policy.rs).
This is a test escape hatch only; the production default stays fully
locked down.
