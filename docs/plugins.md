# Zeolite plugin API (Phase 4)

**Current status: Implemented (static registry, #256).** Chromium does
not support dynamic `import()` in the targeted service worker, so
plugins are compiled into the sw bundle at build time through static
imports. The registry is `app/src/plugins/registry.ts`; there is no
runtime loading of any kind, so plugin code can never come from an
unapproved origin, path or fetched text. A `plugins` entry naming a
module that is not in the build registry is ignored for the request
and emits ONE `UNSUPPORTED` diagnostic per name per worker lifetime
(a `register()` that throws degrades the same way, with a RUNTIME
warning).

A plugin is a TypeScript module in `app/src/plugins/` that exports
`register(hooks)`, listed in a site's `plugins` child node in
`siteconfig.kdl` and added to the registry:

```kdl
site "example.com" {
  plugins "sample-observer"
}
```

```ts
// app/src/plugins/sample-observer.ts
import type { PluginHooks } from "../plugins";
import { DIAG } from "../diag";

export function register(hooks: PluginHooks) {
  hooks.onRequest(({ url, headers }) => {
    if (url.startsWith("https://example.com")) {
      return { headers: { ...headers, "x-plugin": "demo" } };
    }
  });
  hooks.onResponse(({ url, status }) => {
    DIAG.emit({ category: "RUNTIME", severity: "info", message: "saw " + status + " " + url });
  });
}
```

## Contract

- `onRequest({ url, headers })` runs after the SW's header surgery and
  IS awaited before the upstream send. Return `{ headers }` to replace
  the request headers for that request. Return nothing (or
  `undefined`) to leave them as-is.
- `onResponse({ url, status, headers })` is a BEST-EFFORT OBSERVER
  (#256 contract): header edits are ignored, the request engine fires
  it without awaiting, and a throwing hook is isolated from the
  request path. It runs after hostile headers were stripped, and it
  can never delay a response indefinitely.
- `register(hooks)` runs once per plugin per worker lifetime; the
  resolved hook set is memoized.
- Hooks may not read or rewrite the body. Plugins are header/decision
  points; body rewriting is the rewriter's job.
- Plugin code must not touch engine storage, the wisp connection, or
  the rewriter: those are not part of the API surface.

## Scope and limits

A plugin only sees requests for sites whose rule lists it. It sees the
real destination URL, not the engine-local encoded path. It cannot
cancel a request (use the `block` rule for that) and cannot inject
scripts (use the `inject` rule for that).

## Deployment

Plugins ship inside `sw.js` through the vite build: adding a plugin
means adding the module plus one registry line, then a rebuild and
dist publish (see `suite/e2e/plugins-static.mjs` for the real
service-worker verification harness). Files served under a
`/plugins/` path are NOT loadable and are not part of this API.
