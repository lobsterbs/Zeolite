# Error pages (2.3 Selenide)

What a user sees when a proxied navigation fails, and what the engine
can and cannot answer.

## The engine error page (failed navigations)

When a navigation request fails inside the engine (transport error,
DNS failure, TLS failure, policy block, interrupted stream), the
service worker answers with a minimal HTML page it owns:

- one honest category line: dns / tls / timeout / blocked / stream /
  route. The category comes from `classifyFailure` in
  `app/src/errorpage.ts`; an unrecognized failure is reported as a
  stream error, a cause is never invented;
- the Zeolite ASCII logo, centered above the facts;
- a compact monospaced facts list: reason (URL-redacted), category,
  status, trace id and engine version;
- one try-again button: a real button in a GET form back to the same
  engine route (no scripts, so it works on a cold cache);
- a machine-readable `<meta name="zl-error">` payload (JSON:
  category, engine version, route, and when known: reason, traceId,
  status, attribution) for embedders and DevTools;
- an attribution line when the failure is engine-internal (a
  rewrite or route-machinery failure): the page says plainly that
  this is a Zeolite bug, not the site's fault, and links the issue
  tracker with the trace id. Transport and network failures stay
  neutral (the upstream truth is not an engine defect).

Since #32 the page never prints the destination URL. The address bar
already shows the opaque engine route of the failed navigation;
printing the plaintext destination on an engine-origin document would
expose it to any script (or iframe) on that origin. The real
destination stays visible in the privileged surfaces only: the netLog
and diagnostics rings, and the embedder's own devtools. For the same
reason the reason line is URL-redacted before it lands on the page or
in the meta (a transport error string may quote a hop URL); the rings
keep the unredacted string, and the trace id joins the page to them.

Every navigation strand is also recorded in the netLog ring (status,
reason, transport `engine`, fresh trace id) by the `navOutcome` seam
in `app/src/sw.ts`, so the failure is visible in the embedder's
DevTools network panel and joinable with the diagnostics rings; a
strand is never a silent 404.

The page is `color-scheme: light dark` aware, carries no stacks, no
header dumps and no secrets: the structured rings (diag events, trace,
netLog) stay the real diagnostics channel. The page is deterministic:
same failure, byte-identical HTML.

Subresource failures never get a page: they keep the honest
`502 text/plain` body. A failed script or fetch must not paint UI into
the document.

## The no-control case (an engine route with no controller)

If a browser hits an engine route with no controlling service worker,
nothing of the engine runs on that route: there is no code that could
answer, and the engine cannot fix that from inside. The embedder that
hosts the engine origin owns this case. Suggested snippet for the
host server (any static host works; the route prefix is whatever the
deploy uses):

```js
// Node/express shape, for the /j/ route family only.
app.get(/\/(j|zl)\//, (req, res) => {
  res.status(503).send(`<!doctype html>
<meta charset="utf-8">
<title>Engine offline</title>
<p>The engine service worker is not controlling this origin.</p>
<p>Open the engine root once, then reload this page.</p>
<p><a href="/">Engine root</a></p>`);
});
```

Why 503 and not 502: the failure is on the engine side of the route,
not an upstream destination failure. The page should say what happened
(the worker is not installed, not controlling, or outdated) and give
one action: load the engine root so the browser installs/activates
the worker, then retry.

## The embedder implementation (LobsterBrowse, 2026-10-10)

The LobsterBrowse embedder follows this contract and phases its own
error UI out entirely: a failed navigation through a live engine
renders the engine page above inside the frame as-is, and the
embedder only stops its loading spinner and mirrors the
meta[zl-error] payload into its log and DevTools console. The two
embedder-only answers are minimal notices in the same style:

- an engine route with no controlling worker answers 503
  (Engine offline) with one scriptless GET retry form back to the
  same route and one instruction: open the app root once so the
  worker installs, then retry;
- the embedder-only legacy /r/ and /lj/ prefixes keep a 502
  gone-notice (the engine never owned them).

Both notices carry meta[zl-error] (JSON: category, reason) with the
embedder categories offline and route, so the DevTools mirror treats
them like any engine failure. Neither prints the destination URL
(#32); both are deterministic and scriptless.
