# Zeolite interception API + rules engine (Phase 1, 1.1 Oxide)

Two standalone seams shape proxied traffic inside the service worker.
Neither depends on any host application.

## Rules engine (app/src/rules.ts)

Data-driven lists loaded once per SW lifetime from /rules.kdl at the
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

```kdl
block   "doubleclick.net"                  // all types
allow   "challenges.cloudflare.com"
block   "ads.example" { types "script" "image" }
rewrite "http://insecure.example/" "https://insecure.example/"
modify  "news.example" { types "fetch"; header "x-rule" "1" }
```

The shipped /rules.kdl contains the ad + tracker host lists migrated
from the browser app's server-side engine, plus the captcha-host
allowlist. Ghostery's `@ghostery/adblocker` network matcher adds
EasyList-compatible ads and tracking subscriptions. It evaluates the
real upstream URL and the request initiator. The matcher lives in
service-worker memory and loads lazily over Zeolite's Wisp transport;
requests during initial loading use the local host rules until the
matcher is ready. It refreshes after seven days while the worker
remains active. A worker restart reloads it on the next matching
request. If subscription loading fails, local host rules remain active
and Ghostery retries after a short cooldown. List downloads are
limited to Ghostery's HTTPS asset directory; redirects and unsuccessful
responses fail initialization rather than being followed elsewhere.

Local allow entries take precedence over Ghostery. A per-site
`adblock: false` override and the global zl:adblock toggle disable both
the local block list and Ghostery network matches for that site or
session.

## Ghostery cosmetic styles (#551, first slice)

When a document (destination `document`, `iframe` or `frame`) is
served through the HTML rewrite and the Ghostery matcher is loaded and
enabled, the engine's cosmetic filters for the document URL compile to
one stylesheet that is spliced into the rewritten head as a single
`<style data-zl-cosmetic>` element, after the doctype (the same splice
the bootstrap init script rides; the wasm rewriter's `add_injection`
only emits script tags, so the style goes through this seam instead).
Cache-hit documents get the same treatment as fresh ones.

What applies in this slice:

- the engine's `styles` arm for the document URL only: hostname- and
  entity-anchored hide rules plus the engine's precompiled generic
  base stylesheet;
- the gate is the network-blocking gate: the zl:adblock toggle, the
  per-site `adblock: false` override (zl:rules) and the shipped
  captcha/anti-bot allowlist (rules.kdl `allow` entries, the same
  compiled list the block evaluation consults) each refuse cosmetics
  for the document host entirely.

What never applies in this slice, with counts in a per-document
REWRITE diagnostic event (applied / skipped-by-exception /
unsupported, plus a truncation flag; no selectors, no page content):

- scriptlets (`+js(...)`) and extended/HTML filters: counted as
  unsupported, never executed or compiled;
- class-, id- or href-anchored generic hides that need DOM feature
  extraction: the service worker has no DOM at rewrite time, so those
  rules stay dormant;
- frame-ancestor-constrained rules (the frame chain is not tracked
  service-worker side);
- re-injection on dynamic DOM mutations (the engine's
  `dom-update` lifecycle): not shipped;
- stylesheets larger than 64 KiB are truncated at that cap and the
  truncation is reported in the same event.

This is not EasyList/Ghostery cosmetic compatibility: a large share of
every public cosmetic list (DOM-anchored and extended rules) does
nothing here yet. The honest measure of the slice is the diagnostic
counts, not a coverage claim.

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

- Header-only transforms by default: nothing buffers. HTML fetched by
  fetch/XHR remains application data, even with a `text/html` or
  `application/xhtml+xml` response type; only document-loading
  destinations run the streaming HTML rewriter and bootstrap injection.
- A buffered body transform is opt-in and gated: the SW applies it
  only when content-length is known and <= BODY_LIMIT (512 KiB), and
  never for documents or stylesheets (the streaming rewriter owns
  those). The first declared transform wins, stream or buffered alike.
- A STREAMING body transform (#552) is opt-in and un-gated by size:
  the handler declares a stream TransformStream with a required
  maxInputBytes bound and an optional firstOutputMs deadline, and
  the SW pipes the raw body through it with native backpressure. See
  the streaming contract below.
- Transformed responses are not written to the page cache.

## Streaming transform contract (#552)

A response handler may return { stream, maxInputBytes, firstOutputMs? }
where stream is a TransformStream of byte chunks. Ordering and bounds:

- Ordering: the same seam as the buffered arm, after hostile-header
  surgery and before SRI verification, the page cache and the
  HTML/CSS/JS rewriters. A streamed response returns before those
  branches, so it is never page-cached and never re-rewritten,
  exactly like a buffered transform.
- Eligibility: never documents (HTML navigation destinations) or
  stylesheets (the streaming rewriter owns those), and never an
  engine-owned control asset (the /zl-bw/ prelude route, the worker
  prelude and engine assets return from the fetch handler before the
  interception seam, so a stream transform cannot reach them at all).
- Bounds, enforced by engine-owned guards around the plugin pipe:
  a known content-length above maxInputBytes never enters the pipe
  (the raw body serves untouched: fail open, decided before any byte
  flows); an unknown-length body that crosses maxInputBytes mid-flight
  errors the pipe, and a first output chunk that misses firstOutputMs
  errors the pipe. A violating transform turns into network-error-
  shaped semantics for the page (an aborted body, like an upstream
  disconnect), never a raw-and-transformed mixture, and never a hang.
- Native pipe semantics carry the rest: backpressure reaches upstream
  unchanged (the engine retains nothing beyond the pipe queues), a
  page-side cancel propagates back upstream, an upstream error
  propagates forward to the page. Status and headers are preserved;
  the stale upstream content-length is dropped because a transform
  changes the body length.
- Compatibility: the buffered body arm stays exactly as it was.
  Within one handler result the stream outranks the body; across
  handlers the first declared transform of either kind wins.
- Memory stays bounded: the engine never buffers a streamed body
  (only the pipe queues, bounded by their queuing strategies and
  native backpressure), and the declared maxInputBytes caps what the
  guards track. First output is not delayed by the engine: the pipe
  forwards as soon as the transform produces a chunk (the fixtures
  pin a first chunk delivered while the upstream is still open).
- Blocked requests fail at the network level for every non-navigate
  context (a network-error response, like a real blocker: fetch probes
  reject, subresources never load, #500); navigations keep the honest
  engine error page. Blocks land in diagnostics (category
  BLOCKED) and the network log (verdict blocked:rules or
  blocked:intercept).

## Relation to the other seams

- siteconfig.kdl stays the per-site compatibility seam (inject,
  rewrite-time blocked hosts, plugins). rules.kdl is the global
  policy seam; the runtime per-site overrides (zl:rules) are the
  host-app policy seam.
- The WebExtension webRequest runtime stays the extension-compat
  surface; it runs before the rules engine in the request path.
- Plugin hooks (docs/plugins.md) stay per-site header/decision points;
  they observe and adjust after the rules engine and the interception
  API have run.

## Status

Implemented (1.1 Oxide; zl:rules per-site overrides added on the
deep-integration line; Ghostery network matching added on the
Ghostery integration line; Ghostery cosmetic styles shipped as the
#551 first slice, bounded as listed above). Honest limits: rules.kdl
stays global (per-site compatibility stays in siteconfig.kdl; per-site
adblock and UA arrive at runtime via zl:rules); Ghostery cosmetic
coverage is partial by design (scriptlets, extended and DOM-anchored
rules are counted, not applied; no dynamic re-injection); transformed
responses are not page-cached. The streaming transform arm (#552)
carries unknown-length and large bodies behind declared bounds; the
buffered arm stays capped at BODY_LIMIT.
