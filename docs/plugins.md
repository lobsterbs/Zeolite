# Zeolite plugin API (Phase 4)

**Current status: Planned.** Plugin modules are not loaded by the
service worker. Chromium does not support the dynamic `import()` path
the prototype used, so a `plugins` entry in `siteconfig.kdl` is ignored
and emits one `UNSUPPORTED` warning per worker lifetime. Do not ship
site rules that depend on plugin hooks. A future implementation must
use a reviewed static registry or another service-worker-safe loader;
it must not evaluate fetched source text.

A plugin is an ES module served at `/plugins/<name>.js` on the engine
origin. It is listed in a site's `plugins` child node in
`siteconfig.kdl`:

```kdl
site "youtube.com" {
  plugins "strip-trackers"
}
```

The module exports a `register(hooks)` function (named or default):

```js
export function register(hooks) {
  hooks.onRequest(({ url, headers }) => {
    if (url.startsWith("https://youtube.com")) {
      return { headers: { ...headers, "user-agent": "Mozilla/5.0 ..." } };
    }
  });
  hooks.onResponse(({ url, status, headers }) => {
    console.log("plugin saw", status, url);
  });
}
```

## Contract

- `onRequest({ url, headers })` runs after the SW's header surgery.
  Return `{ headers }` to replace the request headers for that request.
  Return nothing (or `undefined`) to leave them as-is.
- `onResponse({ url, status, headers })` is an observer; header changes
  are ignored. It runs after hostile headers were stripped.
- Hooks may not read or rewrite the body. Plugins are header/decision
  points; body rewriting is the rewriter's job.
- This hook contract is design documentation until the loader is
  implemented and verified in a real Chromium service worker.
- Plugin code must not touch engine storage, the wisp connection, or the
  rewriter: those are not part of the API surface.

## Scope and limits

A plugin only sees requests for sites whose rule lists it. It sees the
real destination URL, not the engine-local encoded path. It cannot
cancel a request (use the `block` rule for that) and cannot inject
scripts (use the `inject` rule for that).

## Deployment

Adding a plugin file under `app/dist/plugins/` does not make it
loadable yet. Implement and verify the service-worker-safe loader before
enabling plugin rules.
