# Downloads (1.7 Sulfide)

Zeolite's download manager is a registry of attachment responses, fed by
engine network info. The engine never writes files: service workers
have no disk API, and pretending otherwise would be a fake feature.
What the engine owns is the response stream, so that is what it uses.

## How it works

When a proxied response carries `Content-Disposition: attachment`
(`app/src/sw.ts`, fetch handler), the response body is routed through
a counting passthrough (`app/src/downloads.ts`):

- Bytes keep flowing chunk by chunk. Nothing is buffered: the browser's
  own download machinery receives the stream and writes the file to
  disk exactly as the native flow would.
- The registry records per download: id, filename, MIME, size
  (Content-Length, `-1` when absent), received bytes, source (the
  upstream URL), start/end time, status (`active` / `done` / `error` /
  `cancelled`) and whole-lifetime average speed.

Filename resolution: RFC 6266 `filename` (quoted or token) from
Content-Disposition, then the last path segment of the source URL, then
`download`.

## Control messages

- `zl:downloads` -> `{ ok, downloads: DownloadEntry[] }`, newest first.
- `zl:cancelDownload { id }` -> `{ ok: boolean }`. Cancellation severs
  the counting stream, which aborts the page's download and stops the
  upstream flow. Unknown or already-finished ids return `ok: false`.

## Persistence (2.2 Arsenide)

The ring persists to site-scoped IndexedDB (one record per source
origin, the extension subsystem's idb helper, DB version 3): entries
survive a service-worker restart. Writes are debounced and flush on
lifecycle transitions (registered, done, error, cancelled). On load,
an entry that was active when the worker died is honestly marked
`error` with `interrupted: worker restarted`: no stream survives a
restart. Entry ids stay unique across restarts (the sequence restarts
past every restored id).

## Honest limits

- Only `Content-Disposition: attachment` responses are classified as
  downloads. An anchor download without that header is served as an
  ordinary response; the browser may still save it, but Zeolite does
  not claim to track it.
- Speed is a whole-lifetime average, not a rolling window.
- The ring is bounded (200 entries): old entries are dropped, not
  invented. Since 2.2 the ring persists across SW restarts; before
  2.2 it was in memory only.
- Resuming a partial download is not implemented; cancelling is. A
  persisted `error/interrupted` entry is a record, not a resume
  promise.

