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
  pathScheme?: "b64u" | "mirror";        // codec rotation, default "b64u"
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
| `zl:config` | `prefix`, `scheme` | rotate the URL shape at runtime |
| `zl:adblock` | `enabled` | global toggle for the /rules.json block lists |
| `zl:rules` | `ua`, `rules` (`host`, `adblock`, `ua`) | host-app per-site adblock + User-Agent overrides (rules.ts) |
| `zl:jarProfile` | `profile` (or null) | switch the cookie jar to a throwaway session profile (incognito; cookies.ts) |
| `zl:siteRoute` | `site`, `enabled` | per-site interception toggle (403 when disabled) |
| `zl:teardown` | - | drop all SW caches, `unregister()` |

Page-internal messages (sent by the injected bootstrap, not the host
app): `zl:wsOpen` (`url`, `protocols`, optional `origin`) bridges a
page WebSocket through the transport; since deep-integration item 4
the handshake carries the per-origin identity (Origin + jar cookies +
per-site UA, a fingerprint profile still winning) - the initiator
origin is the message field when present, else recovered from the
controlling client's route (worker-relayed sockets included).
`zl:docCookie` (`origin`, `set`) is the per-origin document.cookie
channel.

## Isolation guarantees (Phase 2 acceptance)

- Storage: proxied site data is namespaced `zl:<sitehash>:` per site;
  engine-origin storage is never exposed to page code.
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
