# Session recording and replay (1.9 Fullerene)

Zeolite can record a session window into a deterministic, replayable
artifact and replay it later as a regression harness for engine
changes. Recording is explicit, bounded and honest about what it never
stores.

## API

The engine adapter (or the devtools page) drives recording with two
service-worker control messages:

    { type: "zl:recordStart", recId?: "nightly" }
    { type: "zl:recordStop" }

- `zl:recordStart` snapshots the current network-ring and tracing-ring
  sequence numbers as cursors, force-enables the opt-in tracing ring
  (recording needs decision data; this is a recording side effect, not
  a surveillance default) and returns `{ ok, record: { id, startedAt } }`.
  Only one recording can be active at a time; a second start is
  rejected with the active id.
- `zl:recordStop` builds the artifact from everything that happened
  between the cursors and returns it in the reply as
  `{ ok, record }`. The tracing ring is restored to its previous
  enabled/disabled state.

An optional `recId` (max 64 chars) names the recording; without one an
id is derived from the start timestamp.

## The zlRecord artifact

```json
{
  "format": "zlRecord",
  "version": 1,
  "engine": "1.9 Fullerene",
  "id": "nightly",
  "startedAt": 1730000000000,
  "stoppedAt": 1730000042000,
  "requests":  [ { "seq": 7, "method": "GET", "dest": "https://a.test/x", "status": 200, "rtype": "DOCUMENT", "bytes": 100, "rewritten": "html" } ],
  "decisions": [ { "seq": 10, "subsystem": "rewriter", "rule": "html", "original": "https://a.test/x", "result": "streaming" } ],
  "websockets": [ { "seq": 11, "kind": "open", "url": "wss://a.test/ws" } ],
  "cookies":   [ { "origin": "https://a.test", "name": "sid", "domain": "a.test", "path": "/" } ]
}
```

- `requests` come from the bounded network inspector ring (256 entries).
- `decisions` come from the tracing ring (rules/intercept/transport/
  rewriter seams). Token-level rewriter internals are not surfaced;
  see docs/tracing.md for the known limit.
- `websockets` are lifecycle events only: open/upgrade/tx/rx/error/close
  with the target URL. Message payloads are never recorded.
- `cookies` record the jar shape only: origin, name, domain, path.
  Values are secrets and never land in a plaintext artifact. This is
  deliberately different from the encrypted 1.7 session export, which
  does carry values inside AES-GCM ciphertext.

## Honest limits

- No request or response bodies, no headers, no timings, no WebSocket
  payloads are recorded. Replay therefore cannot compare them.
- URLs are secret-redacted (query credentials etc.) via the same
  redactor as diagnostics.
- The two timestamps (`startedAt`, `stoppedAt`) are the only volatile
  fields; given identical ring slices the artifact is byte-identical.
- The rings are bounded, so a very long recording sees the oldest
  entries fall off (256 network, 512 tracing).

## Replay

    node suite/replay.mjs --base http://localhost:6002 \
      --session suite/sessions/fixture.session.json --fixture

Replay re-issues every recorded GET destination URL through the
engine's `/j/` path and compares only the stable facts: reachability,
status class (2xx/4xx/5xx), and for HTML responses the absence of
unrewritten absolute href/src URLs. Non-GET requests are skipped with a
note because no body was recorded. A fail exits 1 and writes
`suite/replay-report.json`.

With `--fixture`, the token `%FIXTURE%` in recorded destination URLs is
replaced by a live deterministic fixture origin (started on a random
loopback port), so the checked-in session stays port-independent.
Reaching a loopback upstream requires starting zeolite-server with
`ZL_TEST_ALLOW_PRIVATE_DESTS=1`, a test-only escape hatch in
`crates/zeolite-server/src/policy.rs`. The default SSRF policy blocks
loopback and private destinations and must stay that way in
production.

The nightly compat job runs the replay harness and the capability
scoreboard (see suite/README.md); they do not run on ordinary pushes.
