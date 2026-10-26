# Zeolite Doctor (#495)

Zeolite Doctor is a **read-only, host-only** inspection API. It reports what
the engine has actually observed, and distinguishes **failed**, **warning**,
**unknown**, **skipped** and **passed** checks. A successfully answered Doctor
request (`ok: true`) does **not** imply a healthy deployment. Inspect
`healthy` (`true`, `false`, or `null` for unknown/partial coverage)
and every check's status.

Zeolite is **not** an MCP server. Hosts may integrate the API with their own
diagnostics UI and, if they choose, their own MCP server. LobsterBrowse Beta's
existing MCP implementation is separate; Zeolite has no MCP transport,
permissions or server dependencies.

## Host-side use

Send a message to the Zeolite service worker through its existing
`MessageChannel` control plane, from a **verified host page**. A proxied
site or extension page is refused by the normal host-only sender gate.

```js
const worker = navigator.serviceWorker.controller;
if (!worker) {
  // Doctor cannot run without a controlling worker; report unavailable.
  throw new Error("No controlling Zeolite service worker");
}
const channel = new MessageChannel();
channel.port1.onmessage = (event) => {
  const report = event.data;
  console.log(report);
  channel.port1.close();
};
worker.postMessage({
  type: "zl:doctor",
  expectedScope: new URL("/", location.href).href,
  expectedVersion: "3.0 Diamond", // OPTIONAL; host-supplied *served* bundle version
  probeAssets: false,           // passive is the default
  format: "kdl",                // optional; includes `kdl` string in reply
}, [channel.port2]);
```

Supply an expected scope or version only when the host actually knows
its desired scope and served bundle revision; a self-reported worker
version cannot attest to the server's separately served files.
The worker cannot prove that an arbitrary selected host tab is
controlled merely because its own host-only control message arrived.

## Standalone Zeolite DevTools

Open the engine's own `/devtools.html` under a controlling worker. The
**Zeolite Doctor** panel offers three explicit actions:

- **Inspect:** passive, read-only checks without extra network requests.
- **Check bundle assets:** opt-in, bounded, same-origin HEAD probes only.
- **Export KDL:** downloads the current report as `zeolite-doctor.kdl`
  locally; if no report exists, first requests a passive one.

Unavailable worker/control replies are labelled unavailable. The UI escapes
reported strings through DOM `textContent`, never raw HTML. These controls
do not install or expose an MCP server. LobsterBrowse may independently
surface equivalent API responses in its own DevTools.

## Check semantics

- `worker.running`: the control-plane handler responded. **Not proof**
  that the selected host page has a controller.
- `worker.boot`: bounded (750ms) observation of the existing boot
  promise; timeout = unknown, failure = fail. It does not start boot
  work or change engine settings.
- `worker.scope` and `bundle.version`: compare worker observations
  with the host's supplied expectations; absent evidence = unknown.
- `engine.initialization`: existing degraded flag = fail. No degraded
  flag = unknown; absence of an error is not proof of correct loading.
- `transport.engine`: configured adapter name, not a handshake claim.
- `transport.lifecycle`: last **observed** lifecycle state. A
  `connected` event supports that observation but does not imply an
  authenticated upstream request succeeded. Credential negotiation is
  `transport.wisp-auth=unknown` until separately proven.
- `transport.wisp-endpoint`: WSS scheme/configuration only; a correctly
  formed endpoint does not prove reachability or authenticated WISP.
  Userinfo credentials and fragments are rejected as invalid URL-based
  authentication; query-bearing URLs produce a warning because they
  might contain sensitive tokens. No URL, query value or credential is
  emitted in Doctor JSON or KDL.
- `transport.relay`: registered host port; missing relay is a warning
  because a WISP-only deployment can be valid.
- `config.policy`, `config.rules`, `config.siteconfig`: **state
  telemetry from existing KDL loaders**, not extra network requests.
  They distinguish loaded/parsed, 404/missing, invalid KDL, unavailable
  fetch and never loaded. A missing optional KDL file is a warning,
  not a verified engine crash.
- Worker registration response headers, client-controller status and
  CI bootstrap size facts are explicitly unknown when not observable.

### Opt-in bundle asset checks

`probeAssets: true` sends up to **four concurrent, bounded, same-origin
HEAD** requests from the engine worker to static, worker-sibling
`bootstrap.js`, `codec.js`, `worker-prelude.js` and
`rewriter_wasm_bg.wasm`. Requests omit credentials, forbid automatic
redirect following and have a maximum 3s deadline each (default 1.5s).
No provided URL is used as an outbound destination. If an asset returns
404, redirects to a login page, or returns an HTML SPA fallback in
place of executable content, the check fails; unsupported HEAD or
unobservable errors remain unknown. The check validates **status and
MIME**, not JS/WASM execution or full content integrity.

The probe does not attempt arbitrary network egress, WISP CONNECT,
authentication, TLS negotiations or user-selected endpoints. A future
active WISP test needs its own opt-in fixture with a strictly validated
destination policy.

## KDL export

`format: "kdl"` returns the same report as a versioned KDL document,
`zeolite-doctor version=1`. The report includes only fixed diagnostic
codes, canonical prewritten descriptions and statuses. It excludes
full transport URLs, credentials, virtual origins, trace logs and
arbitrary exception text.

The broader unified debugger and long-term KDL logs are tracked by
[#494](https://github.com/lobsterbs/Zeolite/issues/494). That project
may eventually compose Doctor's typed checks into the shared log schema.
Doctor V1 does not introduce persistent logs or MCP endpoints.

## Integrator contract and limitations

Use `ok` to detect an answered request, **not** overall health. If the
host's controlling service worker is absent, Doctor cannot be queried;
the host UI should label that as `unavailable`. A missing reply also
remains unavailable, never an empty-success snapshot. There is no
server-side collection fallback and no inferred diagnosis for a site
failure. Results are intentionally bounded and contain no raw secrets.

Run integration fixtures before declaring full browser behavior
parity. The dedicated V1 unit suite covers host-only refusal, stalled
boot, scope/version mismatches, malformed/missing KDL loader states,
SPA HTML fallbacks, same-origin-only asset probing and KDL parse
round-trips.
