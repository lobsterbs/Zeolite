# Service worker and injector audit — 2026-10-25

This audit fixes engine-owned failures. It does not claim that every CAPTCHA,
login provider or upstream bot-management system accepts the proxy.

## Implemented fixes

- #416/#428: embedded popup actions use the registered embedder tab bridge;
  key-free navigation markers decode through the same URL oracle. A queued
  startup action stays contained. Embedded `window.open` returns null because
  a real cross-origin WindowProxy cannot be supplied.
- #435/#436: query-route Referer forwarding strips the internal token, and
  widget identity repair uses the browser client's verified virtual context.
  Missing context leaves the provider input unchanged rather than inventing
  Google's origin. This restores request fidelity, not challenge success.
- #438/#442/#444: later transport generations can recover; uncertain relay or
  alternate-Wisp writes are never resent automatically. Cancellation and
  one-shot request bodies keep their replay restrictions.
- #439: worker lifecycle broadcasts share the strict host-page allowlist.
  Query-handle documents, unknown paths and opaque clients are not host pages.
- #429/#437: the profile's UA, Client Hints and window/worker API surfaces
  share one identity. `profile.matchUserAgent=false` preserves the native UA
  surfaces. TLS remains owned by the selected transport or independent relay;
  no UA toggle makes their TLS handshake identical to Chrome.
- #441: active build workflows pin epoxy-tls 2.1.20-1, replacing the version
  deprecated by its maintainer for obsolete CA trust.
- #443: network snapshots redact auth, OAuth and CAPTCHA query data at the
  storage boundary, preserving the actual request outside the log.
- LobsterBrowse #202/#203: diagnostics identify the current document and its
  worker, with scope/generation validation. Favicons are fetched by a controlled
  content-origin client, with image bounds and stale-document rejection.

## Verification and remaining evidence gaps

Unit/type checks, real request-lifecycle fixtures, Chromium popup and production
Browser/favicon fixtures accompany the changes. Exact CI results are attached
 to their pull requests. Fixture success is not a live-site success claim.

Public Outlook and play2048 reproduction remains blocked in the test egress:
Chrome's direct controls returned ERR_EMPTY_RESPONSE, while local Wisp reported
connection/TLS errors. Do not relax cookie Domain checks based on warning lines
alone. Query routes preserve the destination's native pathname; the original
#432 issue's claim that the query shape inherently hides it is inaccurate.
LobsterBrowse #205 separately fixes initial split-origin navigations bypassing
that query shape.

## Next changes worth prioritizing

1. Keep a direct-control and proxied-control compatibility fixture for every
   route shape, referrer policy and widget family; distinguish upstream HTTP
   rejections from routing, runtime and transport failures.
2. Make transport delivery state an explicit result type (not nullable fallback),
   so future adapters cannot accidentally replay an uncertain write.
3. Share host-client classification at every dispatch/control seam and test
   new URL shapes against it before enabling them by default.
4. Diagnose CAPTCHA stages separately: widget URL/context, assets, message
   handshake, user interaction, and upstream verification. Never label all
   failures as "Cloudflare blocked it" without the response evidence.
