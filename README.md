# Zeolite

```text
 _____              ___ __
/__  /  ___  ____  / (_) /____
  / /  / _ \/ __ \/ / / __/ _ \
 / /__/  __/ /_/ / / / /_/  __/
/____/\___/\____/_/_/\__/\___/
```

**A standalone web interception and proxy engine for browser-based hosts.**

[Quick start](#quick-start) · [Features](#features) · [Compatibility](#compatibility) · [Documentation](#documentation)

> **Experimental software.** Zeolite is not production-ready. Compatibility and public APIs can change, and some browser capabilities cannot be reproduced inside a service worker.

## What is Zeolite?

Zeolite gives browser-based hosts a reusable engine for routing web traffic through Wisp, isolating site state, and rewriting content when native browser behavior is not enough.

Its guiding principle is simple: **preserve the website's native behavior wherever possible; rewrite only when necessary.**

Zeolite is a standalone project. It does not depend on LobsterBrowse.

## Features

- **Request interception** — route and control site traffic through a service-worker runtime.
- **Wisp transport** — carry proxied traffic through Zeolite's Wisp transport path.
- **Selective rewriting** — stream HTML and CSS rewriting, plus supported JavaScript URL and module transformations.
- **Site isolation** — virtual origins, per-site cookie jars, and separated storage namespaces.
- **Compatibility APIs** — a growing subset of WebExtension APIs, downloads, WebSockets, and session import/export.
- **Diagnostics and testing** — bounded logs, opt-in rewrite tracing, recording/replay, compatibility probes, and browser end-to-end tests.

## Compatibility

Zeolite has been exercised against real websites, not just synthetic fixtures. Verified working examples include Google Search, Brave Search, ChatGPT, Wikipedia, YouTube, and ordinary content sites. Results can vary with upstream protections, login requirements, and browser behavior.

**CAPTCHA support is working, and remaining compatibility fixes are being addressed.** Supported challenge flows have been tested, including Anubis proof-of-work and Google reCAPTCHA rendering and interaction. Zeolite is not a universal CAPTCHA solver and does not bypass Cloudflare interstitials.

### Important limitations

- Zeolite is not a browser engine; it runs within browser service-worker constraints.
- Some WebExtension APIs and isolated extension worlds are partial or unsupported.
- Proxied-site service workers are represented virtually; the site's real service-worker script is not executed.
- Some page scripts and navigation patterns cannot be rewritten or virtualized reliably.

See the [support matrix](docs/matrix.md) for feature-by-feature status and known gaps.

## Quick start

### Requirements

- Rust and the `wasm32-unknown-unknown` target
- Node.js and npm
- A browser with service-worker support for runtime testing

### Build the WebAssembly crates

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

The server binds to loopback by default. **Do not expose it to a network unless you have deliberately configured authentication and allowed origins.** See the server configuration and security documentation before deploying it.

## Documentation

- [Support matrix and limitations](docs/matrix.md)
- [Security review](docs/security.md)
- [Engine adapter](docs/engine-adapter.md)
- [Plugin API](docs/plugins.md)
- [Roadmap](docs/roadmap.md)
- [Versioning](docs/versioning.md)
- [Performance notes](docs/performance.md)

## Contributing

Bug reports, compatibility findings, and pull requests are welcome. Include the affected site or feature, browser/runtime, reproduction steps, and relevant diagnostics when possible. Remove cookies, tokens, and other secrets before sharing logs.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
