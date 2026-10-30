# Zeolite

```text
 _____              ___ __
/__  /  ___  ____  / (_) /____
  / /  / _ \/ __ \/ / / __/ _ \
 / /__/  __/ /_/ / / / /_/  __/
/____/\___/\____/_/_/\__/\___/
```

**A standalone web interception and proxy engine for browser-based hosts.**

> **Experimental software.** Zeolite is not production-ready. Compatibility and public APIs can change.

## What is Zeolite?

Zeolite gives browser-based hosts (web apps, proxy frontends, kiosk shells) a reusable engine for routing web traffic through a Wisp relay, isolating site state, and rewriting content where native browser behavior is not enough.

Its guiding principle is simple: **preserve the website's native behavior wherever possible; rewrite only when necessary.**

Zeolite is a standalone project. It does not depend on LobsterBrowse.

## What is real today

Every claim below is gated by the repository's own tests; run them yourself with the commands in this README.

- **Wisp v2.1 transport** - handshake, TCP CONNECT, byte-exact relay of requests and responses in both directions, upstream status preservation (301, 302, 307, 404, 500), Set-Cookie relay, and intact media and download bytes. Gated deterministically by `suite/capabilities.mjs` (14 rows).
- **Rewriting (Rust compiled to WASM, driven by the service worker)** - streaming HTML and CSS rewriting, JavaScript URL and module transformations, anchor and URL-literal seams for script data islands, and a hybrid pre-execution location rewrite that is per-origin gated, size capped, and fail-open.
- **Explicit delivery certainty** - every transport failure carries one of three states (`definitely-not-delivered`, `delivered-response`, `delivery-unknown`) plus the transport identity. Non-idempotent requests (POST, PATCH) with unknown delivery are never retried automatically. See [docs/transport-lifecycle.md](docs/transport-lifecycle.md).
- **Site isolation** - virtual origins, per-site cookie jars, separated storage namespaces, and virtual service-worker contexts (register dispatch, capture and forward semantics, postMessage bridging). A registered site's worker script executes in an isolated guest realm (#538), never as a real service worker on the engine scope.
- **Transport engines** - libcurl (WASM) and epoxy (rustls + hyper) with different TLS fingerprints, plus a relay fetch path and Wisp routes. SSRF and authentication are enforced server-side: loopback CONNECT is refused by default and keyless clients are rejected.
- **Compatibility APIs** - a growing subset of WebExtension APIs, downloads, WebSockets, session import and export.
- **Diagnostics** - bounded scoped logs with secret redaction, a compatibility debugger, recording and replay, and two scoreboards (deterministic capabilities; report-only live probes).

## What is partial or not real

Read this before deploying. The engine reports honestly instead of pretending.

- **CAPTCHA** - rendering and interaction are verified for Google reCAPTCHA and Anubis proof-of-work. Zeolite is not a universal CAPTCHA solver, does not promise challenge completion, and does not bypass Cloudflare interstitials. Per-stage challenge tracing is open work.
- **Service workers** - partial: register() spawns the site's worker script in an isolated guest realm (a page-created DedicatedWorker with a harness prelude) with install/activate/fetch events, bounded waitUntil, a bridged fetch() through the engine pipeline, quota-bounded caches, and update()/unregister() lifecycle; accepted in real Chromium (suite/e2e/guest-sw.mjs). Honest limits: cache-hit-speed answers only (250 ms dispatch budget), session-scoped caches, no client enumeration, no controller/controllerchange, no push, no messaging into virtual pages (docs/virtual-service-worker-phase2.md).
- **location** - `window.location` is LegacyUnforgeable: page-level reads of `location.pathname`, `search` and `origin` cannot be intercepted by a shim. The hybrid rewrite fixes script-source reads on gated origins only; everything else keeps route-shaped workarounds with known seams.
- **Egress reality** - sites that bot-wall datacenter IP ranges fail from datacenter deployments regardless of the engine. The probe scoreboard classifies such rows as `egress-gate`; that is an environment fact, not an engine defect.
- **Rewriting limits** - some page scripts and navigation patterns cannot be rewritten or virtualized reliably. When the literal rewriter cannot rewrite a script safely, it falls back conservatively and logs the fallback.
- **WebExtension APIs** - a subset. Isolated extension worlds are partial or unsupported.

See the [support matrix](docs/matrix.md) and [limitations](docs/limitations.md) for feature-by-feature status.

## Architecture

- **Rust workspace**: `zeolite-rewriter` (HTML, CSS and JS rewriters), `zeolite-wisp` (WASM bindings for the service-worker runtime), `wisp-core` and `wisp-extensions` (the Wisp v2.1 protocol), `zeolite-server` (relay and static server).
- **app/**: the TypeScript service-worker runtime. It loads the WASM rewriters and drives interception, isolation and diagnostics. The bootstrap stays JavaScript because it runs before WASM is available.
- **CI** runs five jobs (rust, wasm, app, compat, browser). The browser job includes torture, differential, reload-count and WebSocket e2e suites. Distribution artifacts are published to the `dist` branch; consumers pin a dist commit.

## Quick start

Requirements: Rust with the `wasm32-unknown-unknown` target, Node.js with npm, and a Chromium-based browser for the e2e suites.

```bash
# type-check the WASM crates
cargo check -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown

# app: types, unit suite, build
cd app
npm install
npm run check
npm test
npm run build

# run the standalone server on loopback
cd ..
cargo run -p zeolite-server -- --port 6002 --static app/dist
```

The server binds to loopback by default and parses `--port`, `--static`, `--bind` and `--config`. **Do not expose it to a network unless you have deliberately configured authentication and allowed origins.** See the [security review](docs/security.md) first.

## Testing and scoreboards

```bash
# deterministic transport gate: 14 rows, fails the run on any miss
node suite/capabilities.mjs --base http://localhost:6002

# live-site probe: report-only, classifies egress-gated failures honestly
node suite/probe.mjs --base http://localhost:6002
```

The capabilities scoreboard requires the base server to run with `ZL_TEST_ALLOW_PRIVATE_DESTS=1` and `ZL_TEST_EGRESS=1` so it may reach its loopback fixture. The harness spawns additional servers to verify the production-default SSRF and auth refusals.

## Documentation

- [Support matrix](docs/matrix.md) and [limitations](docs/limitations.md)
- [Transport lifecycle and delivery policy](docs/transport-lifecycle.md)
- [Hybrid location rewrite](docs/hybrid-location-rewrite.md)
- [Virtual service worker](docs/virtual-service-worker-phase2.md)
- [Security review](docs/security.md)
- [Engine adapter](docs/engine-adapter.md) and [integration guide](docs/integration-guide.md)
- [Plugin API](docs/plugins.md) and [policy](docs/policy.md)
- [Performance notes](docs/performance.md), [roadmap](docs/roadmap.md), [versioning](docs/versioning.md)

The `docs/` directory holds more: cookies, session, storage, websocket, workers, recording, tracing, fingerprint, downloads, error pages, network inspector, and more.

## Contributing

Bug reports, compatibility findings, and pull requests are welcome. Include the affected site or feature, browser and runtime, reproduction steps, and relevant diagnostics. Remove cookies, tokens, and other secrets before sharing logs.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
