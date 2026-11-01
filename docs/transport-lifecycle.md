# Transport lifecycle

The wisp WebSocket lifecycle is owned by the vendored transport adapters in
`app/src/libcurl-transport-vendored.ts`, not by the service worker. When the
socket dies, the proactive watcher installed at module evaluation resets the
transport singletons and re-inits with backoff (`reconnectDelay`, 1s doubling,
60s ceiling), so the next request finds a live transport. The request-time
retry in the service worker (connect-class errors) remains the backstop for
mid-stream failures.

#119 closed the observational-only gap: an explicit lifecycle machine
(app/src/transport-lifecycle.ts, states idle / connecting / connected /
dead) is driven by the seams that observe the transport - vendored
init(), the watcher socket open/close events, and reset() - and every
transition reaches DIAG. The request path consults the machine: a
fetch that arrives while the transport is known-dead waits (bounded,
10s) for the reconnect instead of racing it; a timeout is not an
error, the normal path and its honest failure still run. The watcher
stays as a fallback for transports that cannot report, and the
connect-class reset+retry remains the backstop for mid-stream
failures.

Frame-buster neutralization (`crates/rewriter/src/js/antiframe.rs`) is
wired into the streaming rewriter for both script bodies and inline
event handlers, at feature parity with the sibling server-side pass.
Its unit tests run under the rust CI job's `cargo test` step.

## Replay and relay bounds

Transport error messages do not prove non-delivery. After dispatch, automatic retries require an idempotent method and a replayable body; POST/PATCH failures remain terminal even when their text describes an unopened WebSocket. This intentionally favors avoiding duplicated side effects.

Relay credit negotiation is captured per request. Replacing the registered port cannot change the credit protocol of existing streams. Pending response queues are bounded to 4 MiB and 4,096 frames, including legacy peers. Overflow cancels upstream and fails the response; it never silently drops body bytes. Legacy peers still lack cooperative backpressure.

## Explicit delivery evidence (#454)

The internal result contract distinguishes `definitely-not-delivered`,
`delivered-response`, and `delivery-unknown`, with the transport path and
original failure cause. Public fetch methods retain their Response/throw
contract. Failures retain their original cause inside a typed delivery error; relay
keeps its terminal unknown-delivery error behavior. A response means headers arrived; body
completion is separate.

Primary initialization runs before target dispatch and can establish
non-delivery. Once an adapter is called, all failures (including timeouts and
errors suggesting an unopened socket) remain delivery-unknown. Alternate
adapters initialize lazily while sending, so their failures remain unknown.
Relay no-channel/unsupported-body cases are pre-dispatch; channel failure or
invalid response after dispatch is unknown. Abort and one-shot bodies never
replay. Idempotent replay rules remain unchanged. Non-idempotent replay needs
engine-owned pre-dispatch evidence, stored privately rather than inferred
from error text or forgeable properties. Adapter-returned pre-dispatch classifications are reclassified as unknown;
mutable public error properties cannot change private replay evidence.

Fixed diagnostic messages record state and transport without copying error
messages, request bodies, tokens or URLs into this evidence log. Relay port
exceptions and invalid response construction cancel upstream and release
listeners; a broken cancellation port cannot block local teardown.

This is a safety contract, not proof of exactly-once delivery. Full server-side
fault injection at every acceptance boundary, including dropping a connection
after upstream commit, remains required before closing #454. Local adapter
fault tests and typed outcomes do not establish what a remote server committed.

## Redirect re-issue diagnostics and the hop-loop audit (#514)

The CI torture probe's intermittent "zeolite: upstream fetch failed"
signature on the redirect-semantics check now carries hop context from
both ends. Engine-side, an upstream failure on a RE-ISSUE hop (never
the initial fetch) records a bounded UPSTREAM diagnostic naming the
hop index and the status that redirected there - no bodies, no URLs;
the failed hop URL stays in the netlog row the outer catch already
writes. Probe-side, suite/e2e/torture.mjs records which redirect code
failed and the full "zeolite: upstream fetch failed: ..." suffix
(fields failedCode/upstreamError in the probe JSON contract) instead
of a JSON.parse SyntaxError or a 200-character preview.

Audit result on the re-issue path itself (307/308 replay across the
10-hop cap, pinned by unit test with byte equality and single-copy
reference identity): each re-fetch receives the one buffered/spooled
ArrayBuffer, never a re-read of the consumed original stream; the
wedge-guard yield is a single awaited timeout per iteration and cannot
double-fire; and the spool release now rides the same finally as the
transport copy, so a copy over the measured 8 MiB bound frees the
spool file and its live budget immediately instead of stranding it
until the ten-minute orphan sweep (that release-timing defect was the
one concrete finding; it is fixed, minimally). No consumed-stream or
double-re-issue defect was found: the intermittent probe failure
remains diagnosed, not explained - the per-hop diagnostic and the full
error suffix exist so the next red run names its cause instead of
eating it.
