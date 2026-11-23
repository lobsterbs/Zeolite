# Zeolite

```text
 _____              ___ __
/__  /  ___  ____  / (_) /____
  / /  / _ \/ __ \/ / / __/ _ \
 / /__/  __/ /_/ / / / /_/  __/
/____/\___/\____/_/_/\__/\___/
```

**A standalone web interception and proxy engine for browser-based hosts.**

> Experimental software. Not production-ready. APIs can change.

## What is Zeolite?

A reusable engine for browser-based hosts (web apps, proxy frontends, kiosk shells). It routes traffic through a Wisp relay, isolates site state, and rewrites content where native browser behavior is not enough.

One rule drives the design: preserve the site's native behavior wherever possible, rewrite only when necessary.

## Real today

Gated by the repo's own tests. Run them yourself, commands below.

- Wisp v2.1 transport: handshake, TCP CONNECT, byte-exact bidirectional relay, upstream statuses preserved, Set-Cookie relay, media and download bytes intact (`suite/capabilities.mjs`, 14 rows).
- Rust-to-WASM rewriters driven by the service worker: streaming HTML/CSS, JS URL and module transforms, hybrid pre-execution location rewrite, per-origin gated, size capped, fail-open ([details](docs/hybrid-location-rewrite.md)).
- Delivery certainty: every transport failure is `definitely-not-delivered`, `delivered-response`, or `delivery-unknown`; POST/PATCH with unknown delivery is never auto-retried ([policy](docs/transport-lifecycle.md)).
- Site isolation: virtual origins, per-site cookie jars, separated storage, guest-realm service workers (#538).
- Transport engines: libcurl (WASM) and epoxy (rustls + hyper), different TLS fingerprints. SSRF and auth enforced server-side: loopback CONNECT refused, keyless clients rejected.
- WebExtension APIs, tracked member-by-member against Firefox, every gap with a written reason ([gaps](docs/firefox-api-gaps.md)). Downloads, WebSockets, session import/export.
- Diagnostics: scoped logs with secret redaction, debugger, record/replay, two scoreboards.

## Partial or not real

Read this before deploying. The engine surfaces real errors rather than masking them.

- CAPTCHA: rendering and interaction are verified for Google reCAPTCHA and Anubis proof-of-work. It is not a universal CAPTCHA solver, and it does not promise challenge completion or bypass Cloudflare interstitials. Per-stage challenge tracing is open work.
- Service workers: partial. register() spawns the site's worker script in an isolated guest realm (a page-created DedicatedWorker with a harness prelude) with install/activate/fetch events, bounded waitUntil, a bridged fetch() through the engine pipeline, quota-bounded caches, and update()/unregister() lifecycle; accepted in real Chromium (suite/e2e/guest-sw.mjs). Honest limits: cache-hit-speed answers only (250 ms dispatch budget), session-scoped caches, no client enumeration, no controller/controllerchange, no push, no messaging into virtual pages ([details](docs/virtual-service-worker-phase2.md)).
- location: `window.location` is LegacyUnforgeable: page-level reads of `location.pathname`, `search` and `origin` cannot be intercepted by a shim. The hybrid rewrite fixes script-source reads on gated origins only; everything else keeps route-shaped workarounds with known seams.
- Egress: sites that bot-wall datacenter IP ranges fail from datacenter deployments regardless of the engine. The probe scoreboard classifies such rows as `egress-gate`. That is an environment fact, not an engine defect.
- Rewriting: some page scripts and navigation patterns cannot be rewritten or virtualized reliably. When the literal rewriter cannot rewrite a script safely, it falls back conservatively and logs the fallback.
- WebExtension APIs: a subset. Isolated extension worlds are partial or unsupported.

Feature-by-feature: [support matrix](docs/matrix.md), [limitations](docs/limitations.md).

## Quick start

Needs Rust with the `wasm32-unknown-unknown` target, Node.js/npm, and a Chromium browser for e2e.

```bash
cargo check -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown
cd app && npm install && npm run check && npm test && npm run build
cd .. && cargo run -p zeolite-server -- --port 6002 --static app/dist
```

Loopback by default; parses `--port`, `--static`, `--bind`, `--config`. **Do not expose it to a network without auth and allowed origins configured** ([security review](docs/security.md)).

```bash
node suite/capabilities.mjs --base http://localhost:6002  # deterministic gate
node suite/probe.mjs --base http://localhost:6002         # live probes, report-only
```

The capabilities suite needs `ZL_TEST_ALLOW_PRIVATE_DESTS=1` and `ZL_TEST_EGRESS=1` on the base server.

More in `docs/`: engine adapter and integration guide, plugin API, policy, cookies, session, storage, websocket, workers, recording, tracing, fingerprint, downloads, error pages, network inspector, performance, roadmap, versioning.

## Contributing

Issues and PRs welcome. Include the site or feature, browser and runtime, repro steps, diagnostics. Strip cookies, tokens, and secrets from logs.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
