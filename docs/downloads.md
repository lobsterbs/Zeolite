# Downloads (1.7 Sulfide)

Zeolite's download manager is a registry of attachment responses, fed by
engine network info. The engine never writes files: service workers
have no disk API, and pretending otherwise would be a fake feature.
What the engine owns is the response stream, so that is what it uses.

## How it works

When a proxied response carries `Content-Disposition: attachment`
(`app/src/sw.ts`, fetch handler), the response body is routed through
a counting passthrough (`app/src/downloads.ts`):

- Bytes keep flowing chunk by chunk. A first-pass download is never
  buffered whole: the browser's own download machinery receives the
  stream and writes the file to disk exactly as the native flow
  would. Resumable entries (#118) tee the same chunks into a capped
  partial buffer, freed the moment the download completes.
- The registry records per download: id, filename, MIME, size
  (Content-Length, `-1` when absent), received bytes, source (the
  upstream URL), start/end time, status (`active` / `done` / `error` /
  `cancelled` / `paused`), resumability (#118) and whole-lifetime
  average speed.

Filename resolution: RFC 6266 `filename` (quoted or token) from
Content-Disposition, then the last path segment of the source URL, then
`download`.

## Control messages

- `zl:downloads` -> `{ ok, downloads: DownloadEntry[] }`, newest first.
- `zl:cancelDownload { id }` -> `{ ok: boolean }`. Cancellation severs
  the counting stream, which aborts the page's download and stops the
  upstream flow. Unknown or already-finished ids return `ok: false`.
- `zl:pauseDownload { id }` -> `{ ok: boolean }` (#118). Pause severs
  the stream like cancel, but the entry stays resumable: the partial
  bytes are held and persisted, the status becomes `paused`.
- `zl:resumeDownload { id }` -> `{ ok, error? }` (#118, async). Resume
  issues `Range: bytes=<received>-` through the wisp tunnel. A `206`
  continues from the buffered count; a `200` restarts from zero (the
  partial is discarded); a `416` marks the entry `error`.
- `zl:saveDownload { id }` -> `{ ok, blob, filename, mime }` (#118,
  async). Hands the assembled artifact to the UI host, which owns the
  save. `ok: false` when nothing is buffered.

## Persistence (2.2 Arsenide)

The ring persists to site-scoped IndexedDB (one record per source
origin, the extension subsystem's idb helper, DB version 4): entries
survive a service-worker restart. Writes are debounced and flush on
lifecycle transitions (registered, done, error, cancelled, paused).
On load, an entry that was active when the worker died is honestly
marked `error` with `interrupted: worker restarted`: no stream
survives a restart. A `paused` entry (#118) restores as `paused`; its
partial bytes live in the `download-partials` store. Entry ids stay unique across restarts (the sequence restarts
past every restored id).

## Extension handoff downloads (#44)

`downloads.download()` inside an extension broadcasts `zl:downloadOp`
(`{ op: "download", id, extId, url, filename?, saveAs? }`) to the UI
windows; the host owns the save. The host reports back with
`zl:downloadState` (`{ id, status, received?, size?, error? }`,
fire-and-forget, no reply port): the extension downloads registry
updates and the owning extension's `downloads.onChanged` fires, after
an idle MV3 background is woken. `downloads.search` answers from the
same registry; an extension sees only its own handoffs, and terminal
states are final - later reports for the same id are refused.

Honest limits: these ids are the numeric handoff ids from
`zl:downloadOp`, a separate namespace from the `dl<N>` attachment
registry above; a handoff the host never reports stays `active`; and
the registry is in-memory, so a service-worker restart drops it (the
same honest-restart rule as `zl:adblock`).

## Honest limits

- Only `Content-Disposition: attachment` responses are classified as
  downloads. An anchor download without that header is served as an
  ordinary response; the browser may still save it, but Zeolite does
  not claim to track it.
- Speed is a whole-lifetime average, not a rolling window.
- The ring is bounded (200 entries): eviction picks the oldest idle
  entry, never a live stream, so an all-active ring honestly runs
  over capacity instead of losing a running download (#25). Since
  2.2 the ring persists across SW restarts; before 2.2 it was in
  memory only. Eviction (#192) also releases the evicted entry's
  buffered bytes and stored partial, and never takes an entry with a
  resume in flight (the fetch included).
- Buffered partial bytes are capped globally at
  `ZL_DL_BUFFER_TOTAL_MAX` (128 MiB) across every entry (#192). Past
  it the oldest buffers are dropped and their entries honestly lose
  resumability. A resume whose buffer is dropped ends as `error`
  ("artifact not retained"), never as a silent empty result. Known
  limit: partials persisted before a worker restart are not counted
  against the budget until they are loaded again.
- Resume (#118) needs the bytes: a worker cannot reach the partial
  file the browser started writing, so resumable downloads buffer in
  the worker, capped at `ZL_DL_RESUME_MAX` (64 MiB). Above the cap,
  and for every download that completed on its first pass, there is
  honestly nothing to resume from. A resumed artifact must be saved
  through `zl:saveDownload` in the same worker lifetime; a restart
  clears a done entry's buffer.


## browsingData.removeDownloads (#593)

The extension browsingData remover clears the registry's history:
terminal entries (done/error/cancelled/paused) leave the ring with
their stored partials and persisted records, active streams stay
tracked, and the origins/since filters run against each entry's
source origin and end time. The extension handoff registry's terminal
records drop the same way. The files the browser already wrote are
the host's, exactly like Firefox's removeDownloads clearing the list
but not the files.

## Filename sources

`downloadFilename` honors RFC 6266/5987 `filename*` ext-values (charset'lang' prefix stripped, percent-decoded, taking precedence over a plain `filename`); malformed ext-values fall back to the plain `filename`. (#292)
