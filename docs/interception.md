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

## Per-site overrides (zl:rules)

The host app pushes per-site decisions at runtime with the zl:rules
control message:

```
{ type: "zl:rules",
  ua: "<default user-agent, optional>",
  rules: [ { host: "example.com", adblock: false, ua: "Mozilla/5.0 ..." } ] }
```

- adblock false spares that host (and every subdomain, longest host
  suffix wins) from the block list; the allow list still applies, and
  rewrite/modify passes are unchanged. The global zl:adblock disable
  still wins over any override.
- ua is the outgoing User-Agent for that host; the message-level ua is
  the default for hosts without an override. The SW applies it to the
  request headers it builds itself for the wisp transport (User-Agent
  is a forbidden header for a browser fetch, but these requests are
  engine-built). An active fingerprint profile wins over both: the
  wire surface must match the spoofed document surface (1.8).

Like zl:adblock, the overrides are ephemeral: the SW resets them on
restart and the host re-sends on boot and on change.

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
handler is skipped and never breaks a request. Handlers run inside the
SW: no DOM, no page globals.

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
  policy seam; the runtime per-site overrides (zl:rules) are the
  host-app policy seam.
- The WebExtension webRequest runtime stays the extension-compat
  surface; it runs before the rules engine in the request path.
- Plugin hooks (docs/plugins.md) stay per-site header/decision points;
  they observe and adjust after the rules engine and the interception
  API have run.

## Status

Implemented (1.1 Oxide; zl:rules per-site overrides added on the
deep-integration line). Honest limits: rules.json stays global
(per-site compatibility stays in siteconfig.json; per-site adblock and
UA arrive at runtime via zl:rules); transformed responses are not
page-cached.
