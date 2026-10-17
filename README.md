# Zeolite

```
 _____              ___ __     
/__  /  ___  ____  / (_) /____ 
  / /  / _ \/ __ \/ / / __/ _ \
 / /__/  __/ /_/ / / / /_/  __/
/____/\___/\____/_/_/\__/\___/ 
                              
```

**Current release: 3.0 Diamond** · Rust/WASM · Wisp v2.1

> **Status: experimental.** Zeolite is not production-ready. Its engine, API surface, and embed contract may change or break without a deprecation window. Known limitations are documented rather than hidden.

Zeolite is a standalone web interception and proxy engine for browser-based hosts. It combines a service-worker runtime, streaming HTML/CSS/JS rewriting, Wisp transport, virtual origins, storage and cookie isolation, diagnostics, session recording, and partial WebExtension compatibility.

## Why Zeolite

Zeolite is built around one rule:

> **Keep the website native whenever the browser architecture allows it. Rewrite only when necessary.**

The engine owns interception, transport, rewriting, isolation, and diagnostics. Host applications such as LobsterBrowse integrate through the public engine adapter instead of importing Zeolite internals.

## Architecture

The current runtime is:

```
Host application
      │
      ▼
ZeoliteEngine adapter
      │
      ▼
Service Worker
      │
      ├── interception + rules
      ├── origin / cookie / storage isolation
      ├── navigation + worker handling
      ├── diagnostics + tracing
      │
      ├── NativeTransit / transport decision path
      │
      └── RewriteFallback
              │
              ▼
          Wisp v2.1
              │
              ▼
           Upstream
```

NativeTransit is the transport/interception-first direction of the engine. It is intended to make rewriting optional where the browser can preserve the site's native behavior. The existing rewriter remains the fallback path.

Zeolite does not depend on LobsterBrowse and can be built as a standalone engine.

## Features

- **Streaming rewriting** — HTML, CSS, and selected JavaScript URL/module constructs through Rust/WASM.
- **Service-worker interception** — routing, request/response handling, rules, navigation guards, and worker support.
- **Wisp v2.1 transport** — proxied traffic uses the engine's Wisp transport path.
- **Virtual origins** — per-site cookie jars and storage namespaces.
- **Cross-origin subresource routing** — proxied clients route foreign HTTP(S) requests through the engine; host-app traffic remains direct.
- **Opaque page identity** — destination URLs can remain engine-side while pages use opaque routes.
- **HTTPS-only by default** — `http://` destinations upgrade to `https://`; when a site has no TLS the error page offers a one-click proceed-over-HTTP that exempts that host for the session (#144 adjacent, LB #76).
- **Modular extension APIs** — optional `browser.*` namespaces (alarms, cookies, downloads, management, menus, notifications, storage, webNavigation, webRequest) can be detached and reattached at runtime; detached namespaces are absent from the surface so feature detection stays honest.
- **WebSocket bridge** — page WebSockets can be carried through the engine; plaintext `ws://` is upgraded to `wss://` by design.
- **Downloads** — streamed, cancellable download tracking with persistent registry state.
- **Session export/import** — encrypted AES-256-GCM session data with replace and merge modes.
- **Fingerprinting resistance** — consistent document/worker fingerprint profiles rather than per-session randomization.
- **Recording and replay** — deterministic `zlRecord` artifacts with contract-level WebSocket and cookie-jar checks.
- **Diagnostics and tracing** — bounded network logs, diagnostic events, and opt-in rewrite tracing with secret redaction.
- **WebExtension compatibility** — runtime support for a substantial subset of extension APIs.
- **SSRF/destination protection** — destination validation and rebinding-safe IP checks.
- **In-page find** — `zl:find` with shadow-root traversal and CSS Custom Highlight support.
- **Compatibility testing** — fixture probes, real-destination probes, replay tests, and Chromium E2E coverage.

## Important limitations

Zeolite is **not a browser engine**. It runs inside a browser's service-worker environment and works within the capabilities and restrictions of that environment.

Known gaps include:

- Some WebExtension APIs, true isolated extension worlds, and true service-worker execution for proxied sites are still partial or unsupported.
- Proxied-site service-worker registrations are virtual records; Zeolite does not execute the site's real service-worker script.
- Inline module-script specifiers remain a documented rewriting gap.
- `ws://` targets are not sent as plaintext WebSockets; they are upgraded to `wss://`.
- `about:srcdoc` subresource routing is limited by Chromium's service-worker client behavior. The extension-host path does not have the same client-bound limitation.
- Fingerprinting resistance is intentionally deterministic and has known limits around timezone/DST behavior.
- The plugin API is currently documented but its ServiceWorkerGlobalScope dynamic-import loader remains a known implementation gap; no shipped site currently depends on it.

See the full support matrix for exact behavior and per-feature status.

## Working sites

Live-deployment probe results (interactive Chromium runs against a hosted
LobsterBrowse/Zeolite deployment, 2026-10). Sites are listed honestly:
what works is verified by driving the page, and failures are classified
as engine bugs, environmental walls, or documented design limits.

### Verified working

- **Wikipedia** - search suggestions, search results, full article navigation.
- **YouTube** - watch pages boot, the video element reaches a ready state.
- **slither.io** - canvas renders, nickname entry and server join work.
- **Brave Search** - full SERP with favicons; subresource MIME checks pass
  standalone. The Ask AI tab now boots through the engine (verified
  2026-10-16 live): #235 ships the AST pass in the wasm rewriter that
  renames page `location` reads (bare and member reads, scope-aware)
  to the `__zl` virtual location, and #236 ships the runtime
  `applyVloc` location view over the virtual path/query/hash with
  pushState/replaceState re-anchoring, so the SvelteKit client router
  matches `/ask` on the virtual pathname instead of the opaque engine
  route (its regression fix stops the re-anchored `__zl_prel__` tail
  from snowballing across SPA fallback reloads, which previously ended
  in 429 retry loops and 414 Request-URI-Too-Long). Ask answers
  stream through the engine now (verified 2026-10-17 live on the
  beta deployment, dist a84c43f): the last blocker was #238 -
  SvelteKit's client start() compares `document.URL` with
  `location.href` and self-assigns `location.href` when they differ
  (kit PR 11179, a basic-auth credential drop); the #235 pass had
  renamed `location.href` reads to the virtual `__zl.href` but left
  `document.URL` native, so against the opaque navh route the
  compare never passed and start() re-navigated on every load (43
  identical document loads in ~30s live), tripping Brave's
  request-pattern 429 + PoW interstitial. The globals pass now also
  rewrites scope-resolved `document.URL` and `document.documentURI`
  reads to `__zl.href` (writes, deletes and shadowed receivers stay
  native), so the check never fires: the full Ask flow completes
  with three document navigations total (search, post-verify,
  /ask), zero re-drive loops, and the answer streams in-app. Brave
  still serves its bot-check interstitial on a cold session's first
  fresh load through the wisp class (the clearance then survives in
  the cookie jar); the challenge completes through the engine with
  one Verify click, which ScramJet from the same egress is not
  asked for (recorded #238 evidence). The wall is keyed on the
  request pattern, not on the exit IP class; the datacenter-IP
  claim that stood here was wrong (retracted).
- **Hacker News, example.com, plain content sites** - full load.

### Captcha and challenge coverage

- **Anubis proof-of-work challenges** - solved in-engine (verified on
  Startpage).
- **Google reCAPTCHA** - the widget renders and communicates through the
  engine (Referer, `co=` domain virtualization, anchor/bframe message
  ports). Interaction inside the challenge frame works; the engine does
  not auto-solve challenges.
- **Cloudflare interstitials** - never bypassed; detection only, by design.

### Environmental failures (not engine bugs)

- **Google Search** - the shared datacenter exit IP is risk-flagged and
  serves the sorry/captcha wall.
- **duck.ai** - upstream TLS refuses the host's IP range.
- **chatgpt.com** - anonymous chat is login-walled upstream.
- **krunker.io** - datacenter-IP bot wall.

### Documented design limits

- **SPA routers that branch on `location.pathname`** (play2048.co, some
  Google AI Mode surfaces) used to render their own client-side 404 view
  because the page identity was fully opaque. `window.location` is
  `[LegacyUnforgeable]`, so no page shim can virtualize it. #144 ships
  the split-identity handle: `zl:navHandle` answers
  `/__zl_navh__/<opaque token>/<real path>?<real query>` - the token
  carries the destination origin only, the real path and query are
  visible on the route, so pathname routing and location-relative URL
  building work without any location virtualization (this is why the
  github.com append class now boots). The host stays opaque to the
  browser, history and extensions; the path exposure is a recorded
  decision (docs/security.md). Routers that string-match the bare
  opaque token without tolerating the suffix used to stay limited by
  the LegacyUnforgeable location; #235/#236 fix that class for scripts
  the rewriter processes (page `location` reads are renamed to the
  `__zl` virtual location at rewrite time, and the runtime serves the
  virtual path/query/hash). Code the pass cannot rewrite (parse
  failures, unrewritten script bodies) still reads the opaque route,
  and `window.location` itself stays LegacyUnforgeable and native.
- **Runtime-constructed asset names** - single-segment script/style names
  built by page code at runtime (github.com module CSS) are recovered by
  the global observed asset-base heuristic (#134).
## Repository layout

| Path | Purpose |
| --- | --- |
| `crates/rewriter` | Rust/WASM HTML, CSS, and JS-literal rewriting |
| `crates/wisp-core` | Wisp v2.1 protocol implementation |
| `crates/wisp-wasm` | WASM wrapper used by the browser runtime |
| `crates/wisp-extensions` | Server-side Wisp extensions |
| `crates/zeolite-server` | Standalone Wisp relay and static engine server |
| `app/src/sw.ts` | Main service worker runtime |
| `app/src/engine.ts` | Public host/engine adapter |
| `app/src/extensions` | WebExtension runtime |
| `app/src/cookies.ts` | Virtual origins and cookie jars |
| `app/src/diag.ts` | Bounded diagnostics |
| `app/src/tracing.ts` | Opt-in rewrite tracing |
| `app/src/downloads.ts` | Download registry |
| `app/src/session.ts` | Encrypted session export/import |
| `app/src/fingerprint.ts` | Fingerprint profiles |
| `app/src/recording.ts` | Deterministic session recording |
| `app/src/finder.ts` | In-page find |
| `suite` | Compatibility probes, replay harness, capability scoreboard, and Chromium E2E |
| `docs` | Architecture, support matrix, security, performance, versioning, and roadmap |

## Quick start

### Prerequisites

- Rust toolchain with the `wasm32-unknown-unknown` target
- Node.js and npm
- A browser with service-worker support for runtime testing

### Build the WASM crates

```bash
cargo build -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown --release
```

### Build and test the app

```bash
cd app
npm install
npm run check
npm test
npm run build
```

### Run the standalone server

From the repository root:

```bash
cargo run -p zeolite-server -- --port 6002 --static app/dist
```

The server binds loopback (127.0.0.1) by default: it is an open relay to the public internet, so exposing it to a network (`--bind 0.0.0.0` or `ZL_BIND`) is an explicit operator decision. Wisp auth is configured with `ZL_WISP_USER`/`ZL_WISP_PASSWORD` or `ZL_WISP_ED25519_HEX`; an invalid or half-set auth configuration refuses to start rather than silently running open. Browser origins are checked on the wisp upgrade (`ZL_ALLOWED_ORIGINS` to allowlist cross-origin embedders). Server settings may also live in a KDL config file (`--config server.kdl` or `ZL_CONFIG`, layered defaults < file < environment < flags); a malformed file, an unknown setting or a half-set auth block refuses to start instead of silently running defaults.

Then run the compatibility probe suite:

```bash
node suite/probe.mjs --base http://localhost:6002
```

The exact generated WASM assets and transport bundle used by the browser runtime are produced by the repository's build/CI pipeline.

## Diagnostics

Runtime diagnostics are deliberately bounded:

- 256 network-log entries
- 512 diagnostic events
- 256 trace references
- 512 tracing decisions
- 512 KiB interception-body cap

Secrets are redacted when diagnostic data enters the engine.

## Documentation

- [Support and limitation matrix](docs/matrix.md)
- [Security audit](docs/security.md)
- [Performance audit](docs/performance.md)
- [Versioning](docs/versioning.md)
- [Roadmap](docs/roadmap.md)
- [Engine adapter](docs/engine-adapter.md)
- [Plugin API](docs/plugins.md)

GitHub also generates a table of contents for the README from these headings, so the document intentionally keeps detailed API/reference material in `docs/` rather than turning this page into a wall of text.

## Roadmap and status

The original feature roadmap is complete through **3.0 Diamond**. The 3.x public API is frozen around the documented control plane, `ZeoliteEngine` adapter, rewriter WASM interface, and route codec surface.

The project still has known compatibility limitations and ongoing hardening work. The roadmap being complete does **not** mean Zeolite is production-ready.

## Contributing

Bug reports, compatibility findings, and improvements are welcome through GitHub issues and pull requests. When reporting a compatibility problem, include the affected feature, browser/runtime, reproduction steps, and relevant diagnostics when possible.

## License

Zeolite is licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE).
