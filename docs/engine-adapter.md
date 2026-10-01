# Zeolite engine adapter (Phase 2 contract — IMPLEMENTED)

## How LobsterBrowse loads Scramjet today

LobsterBrowse embeds Scramjet as a full-page iframe: the tab points at
the engine service URL with `?url=<target>` (`scramjet/public/index.js`
hides its demo UI, registers the Scramjet SW, and opens the target in a
full-viewport frame). The engine owns its origin because its service
worker must control every proxied request. The UI never calls engine
APIs; it only swaps the iframe URL.

Zeolite conforms to the same embed contract:

```
https://<zeolite-host>/?url=<encoded-target>
```

`app/src/main.ts` brings up the engine via the adapter, rehydrates
persisted per-site toggles, and navigates the frame to the encoded
route. No changes to LobsterBrowse are needed to present the choice:
both engines are just embed URLs.

One contract detail an embedder must keep: the engine's service worker
is registered as a module worker
(`navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" })`).
The bundle emits `sw.js` as an ES module (it shares chunks with
`main.js`), so a classic registration fails at script evaluation with
nothing surfaced below the `register()` call, and Chromium 91+ is
required. An embedder that registers the worker itself must pass the
same `type`. The page- and worker-facing artifacts (`bootstrap.js`,
`worker-prelude.js`, `finder.js`) are the opposite: they are built as
classic single-file scripts, because a `<script src>` without
`type="module"`, a classic worker script and page `eval` cannot parse
ESM syntax.

## JS adapter

Implemented in `app/src/engine.ts` (class `ZeoliteEngine`). Field-for-field with the sketch:

```ts
export interface ZeoliteEngine {
  /** Register the SW on the engine origin, wait for control, push
   *  config (URL scheme rotation) to it. Idempotent. */
  init(config: EngineConfig): Promise<void>;
  /** Navigate to a destination (returns the engine-local route URL). */
  navigate(target: string): string;
  /** Enable/disable interception for one site (per-site toggle),
   *  acknowledged by the SW and persisted across SW restarts. */
  setSiteRoute(site: string, enabled: boolean): Promise<void>;
  /** Uninstall the SW, drop all caches, clear adapter state. Called
   *  when the user switches engines so nothing leaks. */
  teardown(): Promise<void>;
}

interface EngineConfig {
  wispUrl?: string;                       // default wss(s)://<origin>/wisp/
  pathScheme?: "b64u";                       // fixed since #32, mirror removed
  pathPrefix?: string;                    // default "/j/"
  profile?: string;                       // cookie jar profile, default "default"
}
```

## Control plane (SW postMessage protocol)

Messages carry a `MessageChannel` reply port; every operation is
acknowledged, never fire-and-forget. The full live list is documented
in `app/src/sw.ts`; the adapter-relevant subset:

| message | payload | effect |
| --- | --- | --- |
| `zl:ping` | - | liveness probe (echoes version, degraded, route shape) |
| `zl:config` | `prefix` | rotate the route prefix at runtime; the scheme is fixed to `"b64u"` since #32, any other `scheme` value is rejected |
| `zl:adblock` | `enabled` | global toggle for the /rules.json block lists |
| `zl:rules` | `ua`, `rules` (`host`, `adblock`, `ua`) | host-app per-site adblock + User-Agent overrides (rules.ts) |
| `zl:jarProfile` | `profile` (or null) | switch the cookie jar to a throwaway session profile (incognito; cookies.ts) |
| `zl:getJars` | - | enumerate jar profiles with per-origin cookie records (#41; host-only: proxied-page senders are refused) |
| `zl:clearJar` | `profile`, `origin` | clear the active or named jar profile, or one origin inside it (#41; host-only) |
| `zl:listMenus` | `extId?` | list registered context-menu items of enabled extensions (id, title, contexts, parentId, type, checked) so the host can render its menu surface (#45) |
| `zl:downloadState` | `id`, `status` (`active`/`done`/`error`/`cancelled`), `received?`, `size?`, `error?` | host reports a `zl:downloadOp` handoff's state back; updates the extension downloads registry and fires `downloads.onChanged` for the owning extension after waking its background (#44) |
| `zl:notifyEvent` | `extId`, `msg: { id, event, buttonIndex? }` | host reports a rendered notification's interaction back (`zl:notifyOp` is the SW->host create/clear broadcast); fires the extension's `notifications.onClosed`/`onClicked`/`onButtonClicked` after waking its background (#43) |
| `zl:openExtPage` | `extId`, `which?` (`options`/`popup`, default `options`) | resolve an extension's options/popup page and mint a 5-minute page token; answers `{ ok, url }` where `url` is the `/zl-ext/<id>/<page>?zlPageTok=<token>` the host should navigate a tab to (#40; host-only) |
| `zl:extPage` | `extId`, `msg: { path, args }` | internal RPC from an extension-origin page's bridge (not for the host); the sender must be a client registered as that extension's page and the path is whitelist-gated in the page API (#40) |
| `zl:siteRoute` | `site`, `enabled` | per-site interception toggle (403 when disabled) |
| `zl:teardown` | - | drop all SW caches, `unregister()` |
| `zl:find` | `dest`, `cmd` (`find`/`next`/`prev`/`clear`), `pattern`, `options` (`caseSensitive`, `wholeWord`, `wrap`) | in-page find in the addressed proxied document (#29): the page-side finder replies `{ ok, matches, ordinal (1-based), highlight }`; open shadow roots searched, CSS Custom Highlight API where available (`highlight: "none"` = counts only). Addressing is controller-side: `dest` selects the client SW-side and the findLoad message posted to the page carries no destination (#32) |

Page-internal messages (sent by the injected bootstrap, not the host
app): `zl:wsOpen` (`url`, `protocols`, optional `origin`) bridges a
page WebSocket through the transport; since deep-integration item 4
the handshake carries the per-origin identity (Origin + jar cookies +
per-site UA, a fingerprint profile still winning) - the initiator
origin is the message field when present, else recovered from the
controlling client's route (worker-relayed sockets included).
`zl:docCookie` (`origin`, `set`) is the per-origin document.cookie
channel.

`zl:findLoad` is the SW-to-page half of `zl:find`: the bootstrap
evaluates the attached finder source (finder.js) once per document
and the finder answers on the transferred port. A page that never
answers - no bootstrap, a CSP that blocks eval, a hostile context -
fails the command honestly after 10 seconds instead of hanging the
find bar.

## Isolation guarantees (Phase 2 acceptance)

- Storage: proxied site data is namespaced `zl:<sitehash>:` per site;
  engine-origin storage is never exposed to page code.
- Host-app traffic is untouched by #34: the SW routes foreign-origin
  requests only for proxied clients (client URL decodes to an engine
  route, or a #33 virtual context exists). The embedding app's own
  cross-origin calls keep the direct browser path.
- SW state: `teardown()` unregisters `/sw.js` and deletes every cache
  it owned, so switching engines leaves no interception active.
- Session export/import is NOT implemented. The 1.7 `zl:exportSession`
  control-plane message (encrypted, SW-side) is the live session
  transfer path; this adapter never shipped its own plaintext blob.

## Keepalive / reconnect

There is no client-side heartbeat. The vendored libcurl transport
multiplexes every stream over one WebSocket; when the socket drops the
transport reconnects on the next request, and page fetches fail loudly
rather than hang. (The old `wisp.ts` heartbeat client was dead code
from the pre-vendoring era and has been removed.)

## Status

- Phase 2 adapter surface: implemented (engine.ts + sw.ts control plane
  + codec rotation).
- Pending before "done": runtime validation of the full switch path
  (Scramjet -> Zeolite -> teardown -> Scramjet) on a real deployment,
  which also requires the Phase 1 transport vendoring to land first.
