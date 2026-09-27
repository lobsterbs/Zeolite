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

## Honest limits

- Only `Content-Disposition: attachment` responses are classified as
  downloads. An anchor download without that header is served as an
  ordinary response; the browser may still save it, but Zeolite does
  not claim to track it.
- Speed is a whole-lifetime average, not a rolling window.
- The registry is in memory with a bounded ring (200 entries): it does
  not survive a service-worker restart, and old entries are dropped,
  not invented.
- Resuming a partial download is not implemented; cancelling is.
