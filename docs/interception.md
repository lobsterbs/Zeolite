# Zeolite interception API + rules engine (Phase 1, 1.1 Oxide)

Two standalone seams shape proxied traffic inside the service worker.
Neither depends on any host application.

## Rules engine (app/src/rules.ts)

Data-driven lists loaded once per SW lifetime from /rules.json at the
engine origin:

| list | effect |
| --- | --- |
| block | request answered 403 before cache and transport |
| allow | overrides block (captcha/anti-bot hosts must never be stripped) |
| rewrite | replaces a URL prefix (for example http to https) before transport |
| modify | merges headers into the outgoing request |

Every entry takes an optional types filter (resource types: document,
script, style, image, font, media, websocket, worker, manifest,
eventsource, wasm, fetch, other). Host matching follows the
siteconfig grammar: exact hostname or any parent domain.

The shipped /rules.json contains the ad + tracker host lists migrated
from the browser app's server-side engine, plus the captcha-host
allowlist, so client-side mode blocks the same hosts.

The host toggles the compiled data with the zl:adblock control message
({ type: "zl:adblock", enabled: boolean }). Disabled rules are a
no-op; the data stays loaded. The flag resets to enabled on SW
restart, so the host re-sends it on boot.

## Interception API (app/src/intercept.ts)

```ts
import { intercept } from "./intercept";

const off = intercept("request", ({ url, method, rtype, headers }) => {
  if (new URL(url).hostname === "example.com") return { block: true };
  return { headers: { ...headers, "x-flag": "1" } };
});
```

Kinds:

- request: every proxied request, before cache and transport. May
  block, rewrite the destination URL, or merge outgoing headers.
- response: every proxied response after hostile-header surgery. May
  merge response headers, and may declare an opt-in body transform.
- navigation / worker / websocket / fetch: filtered views over the
  same request stream (document-mode, worker-dest, websocket-dest,
  subresource fetch/XHR). Observe and block.

Semantics: any blocking handler blocks; the first URL rewrite wins;
header maps merge with later handlers winning per key. A throwing
handler is skipped and never breaks a request. Handlers run inside
the SW: no DOM, no page globals.

## Streaming guarantees

- Header-only transforms by default: nothing buffers.
- A response body transform is opt-in and gated: the SW applies it
  only when content-length is known and <= BODY_LIMIT (512 KiB), and
  never for documents or stylesheets (the streaming rewriter owns
  those). Oversized or unknown-size responses pass through untouched.
- Transformed responses are not written to the page cache.
- Blocked requests are answered 403 and land in diagnostics (category
  BLOCKED) and the network log (verdict blocked:rules or
  blocked:intercept).

## Relation to the other seams

- siteconfig.json stays the per-site compatibility seam (inject,
  rewrite-time blocked hosts, plugins). rules.json is the global
  policy seam.
- The WebExtension webRequest runtime stays the extension-compat
  surface; it runs before the rules engine in the request path.
- Plugin hooks (docs/plugins.md) stay per-site header/decision points;
  they observe and adjust after the rules engine and the interception
  API have run.

## Status

Implemented (1.1 Oxide). Honest limits: rules.json is global
(per-site compatibility stays in siteconfig.json); the host's
per-site adblock overrides apply only to the server-side engine;
transformed responses are not page-cached.
