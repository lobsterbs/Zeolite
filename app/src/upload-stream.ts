/* #556: queue-backed upload stream controller for the forked libcurl
   bundle's streaming upload seam (params.upload = { read, chunkSize,
   contentLength }, vendor/libcurljs/FORK-NOTES.md).

   The wasm read callback is SYNCHRONOUS: libcurl.js drives curl_multi
   from a non-blocking JS loop. This controller bridges an async source
   (a spooled OPFS File, or any Blob) to that callback: a small queue of
   chunks is pumped ahead; read() serves from the queue, returns -1
   (pause) when it runs dry and the fork's resume() seam continues the
   transfer once the pump lands data, returns 0 at EOF, and -2 on a
   failed read so the transfer aborts (CURLE_ABORTED_BY_CALLBACK)
   instead of silently truncating the upload.

   No full in-memory copy exists at any point: the source is read in
   chunkSize slices and at most UPLOAD_QUEUE_CHUNKS chunks are live.
   Leaf module on purpose: the vendored transport adapter imports it
   without a cycle. Unit-gated in __tests__/upload-stream.test.ts. */

export const UPLOAD_CHUNK_BYTES = 65536;
export const UPLOAD_QUEUE_CHUNKS = 2;

export interface UploadController {
  chunkSize: number;
  /** Exact upload length when known (Blob.size); the fork rides it as
      INFILESIZE so known-length bodies avoid chunked framing. */
  contentLength: number;
  /** Assigned by the fork bundle when it arms the seam: resumes a
      paused transfer (curl_easy_pause, CURLPAUSE_CONT). Null only
      before the fork arms it (unit fakes set their own). */
  resume: (() => void) | null;
  /** Synchronous read callback: write at most max bytes into view
      (a wasm heap view), return the count, 0 for EOF, -1 to pause,
      -2 to abort. */
  read(view: Uint8Array, max: number): number;
}

export function blobUploadController(blob: Blob, chunkSize = UPLOAD_CHUNK_BYTES): UploadController {
  let offset = 0;
  let eof = false;
  let failed = false;
  let pumping = false;
  let paused = false;
  const queue: Uint8Array[] = [];
  const ctrl: UploadController = {
    chunkSize,
    contentLength: blob.size,
    resume: null,
    read(view: Uint8Array, max: number): number {
      if (failed) return -2;
      if (queue.length === 0) {
        if (eof) return 0;
        /* Nothing buffered: pause the transfer and let the pump resume
           it. Kick the pump defensively (a no-op while a pump is
           already in flight); the invariant is that every completed
           pump leaves data queued, EOF, failure, or a pump in flight. */
        paused = true;
        void fill();
        return -1;
      }
      const head = queue[0];
      const n = Math.min(head.length, view.length, max);
      view.set(head.subarray(0, n));
      if (n < head.length) queue[0] = head.subarray(n);
      else queue.shift();
      void fill();
      return n;
    },
  };
  const drain = (): void => {
    if (!paused) return;
    paused = false;
    try {
      ctrl.resume?.();
    } catch {
      /* resume after the transfer finished: the fork's resume is a
         no-op on a closed handle; a unit fake's throw is swallowed */
    }
  };
  const fill = async (): Promise<void> => {
    if (pumping || eof || failed) return;
    pumping = true;
    try {
      while (queue.length < UPLOAD_QUEUE_CHUNKS && !eof && !failed) {
        if (offset >= blob.size) {
          eof = true;
          break;
        }
        const buf = await blob.slice(offset, offset + chunkSize).arrayBuffer();
        offset += buf.byteLength;
        if (buf.byteLength === 0) {
          eof = true;
          break;
        }
        queue.push(new Uint8Array(buf));
      }
    } catch {
      failed = true;
    }
    pumping = false;
    drain();
  };
  void fill();
  return ctrl;
}
