# Zeolite plugin API (Phase 4)

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
- Failures are swallowed and logged. A broken plugin degrades to a
  no-op and never breaks a request.
- Plugins are loaded once per SW lifetime (memoized per name) and run
  inside the SW: they have no DOM and no page globals.
- Plugin code must not touch engine storage, the wisp connection, or the
  rewriter: those are not part of the API surface.

## Scope and limits

A plugin only sees requests for sites whose rule lists it. It sees the
real destination URL, not the engine-local encoded path. It cannot
cancel a request (use the `block` rule for that) and cannot inject
scripts (use the `inject` rule for that).

## Deployment

Drop the built module at `app/dist/plugins/<name>.js`. Nothing in the
engine source needs to change: loading is fully data-driven from
siteconfig.kdl, which is how a third party can ship a plugin without
touching engine source (the Phase 4 done-when).

Known gap: `app/src/plugins.ts` loads plugin modules with dynamic
`import()`, which Chromium does not support on
`ServiceWorkerGlobalScope`. A plugin listed in siteconfig therefore
fails to load (honestly, logged) inside the service worker until the
loader gains a SW-safe path (fetch + evaluate, as the libcurl transport
seam does). No site currently ships plugins, so nothing regresses.
