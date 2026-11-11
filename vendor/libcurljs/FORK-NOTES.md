# libcurl.js fork: streaming request bodies (#556)

This is a fork of ading2210/libcurl.js (0.7.4, commit a641cdd, AGPL-3.0)
carrying one change: a streaming upload path so large request bodies no
longer have to exist as ONE contiguous buffer in wasm memory.

The base is 0.7.4, not 0.7.5: bisected via CI builds (2026-11-11), the
pristine 0.7.5 dependency set (curl 8.23.0-patched) stalls every response
through the libcurl-transport wrapper (transport init ok, upstream request
logged, no response ever arrives), while the 0.7.4-era pins (curl
8.17.0-patched) complete normally. The seam files are byte-identical
between the two bases, so the rebase is exact.

## Why

Upstream takes the whole request body through a single
CURLOPT_POSTFIELDS buffer: the JS seam (client/javascript/http.js,
request_async) calls allocate_array(body) once and hands the pointer to
http_set_options. A 4 GB spooled upload therefore needs 4 GB of
contiguous wasm heap. Zeolite issue #556 tracks the engine-side need to
stream spooled bodies; this fork is the library-side enabler.

## The change

- client/libcurl/types.h: RequestInfo carries upload_fn (a JS function
  pointer registered with Module.addFunction), upload_buf (a heap
  scratch buffer) and upload_buf_size.
- client/libcurl/http.c: upload_read_callback implements
  CURLOPT_READFUNCTION; http_set_upload_stream(handle, js_fn,
  chunk_size, infilesize) arms it (CURLOPT_UPLOAD, INFILESIZE_LARGE =
  infilesize, chunked when negative); http_pause(handle, bits) exposes
  curl_easy_pause so the JS side can resume a paused transfer; a -2
  read return maps to CURL_READFUNC_ABORT.
- client/libcurl/request.c: the scratch buffer is freed in
  finish_request and in request_cleanup.
- client/exported_funcs.txt: http_set_upload_stream and http_pause
  exported.
- client/javascript/http.js: request_async accepts
  params.upload = { read, chunkSize, contentLength }. read(view, max)
  is invoked SYNCHRONOUSLY from inside the transfer loop with a
  Module.HEAPU8 view of the scratch buffer: write at most max bytes
  into the view, return the count, 0 for EOF, -1 to pause the
  transfer, or -2 to abort it. The fork wires params.upload.resume to
  http_pause(handle, 0) (CURLPAUSE_CONT) so the caller resumes a
  paused transfer without touching the handle; the function pointer is
  removed from the table in finish_callback (no table growth leak).
  create_options skips body materialization when the seam is armed.

## Protocol notes

- The read callback stays synchronous on purpose: libcurl.js drives
  curl_multi from a non-blocking JS loop, so an async callback cannot
  block the transfer. The pause/continue protocol is the bridge.
- read(view, max) returns the count, 0 for EOF, -1 to pause (the fork
  wires params.upload.resume to http_pause(handle, CURLPAUSE_CONT) so
  the caller never touches the handle), or -2 to abort
  (CURL_READFUNC_ABORT: a failed source surfaces as
  CURLE_ABORTED_BY_CALLBACK, never as a silently truncated upload).
- A non-negative params.upload.contentLength rides INFILESIZE_LARGE so
  known-length bodies avoid chunked framing; negative or absent keeps
  INFILESIZE -1 (chunked).
- create_options skips the Request.arrayBuffer() materialization when
  params.upload.read is armed; the header dict defaults (User-Agent,
  Content-Type from the Blob) are built without it.
- The method still comes from the "method" JSON option
  (CURLOPT_CUSTOMREQUEST); with CURLOPT_UPLOAD that keeps POST a POST.

## Building

Requires emscripten (emcc) and the C dependency chain
(tools/all_deps.sh compiles curl, mbedtls, cjson, zlib, brotli,
nghttp2 for wasm):

    git clone --recursive https://github.com/ading2210/libcurl.js
    cd libcurl.js/client
    source ../emsdk/emsdk_env.sh   # or your emsdk
    ./build.sh release

Output: out/libcurl.mjs (+ out/libcurl.wasm). Zeolite vendors the
bundled single-file variant; build with "./build.sh release single_file"
for libcurl_full.mjs and re-vendor app/public/libcurl/index.mjs.

## Zeolite integration (remaining work, issue #556)

1. Point the vendored bundle at this fork's build output (re-vendor
   app/public/libcurl/index.mjs from "./build.sh release single_file").
2. app/src: arm params.upload = { read, chunkSize, contentLength } for
   Blob/File bodies in the vendored adapter
   (libcurl-transport-vendored.ts) when the bundle source carries the
   seam; the queue-backed controller (app/src/upload-stream.ts) reads
   the spool File in chunks, returns -1 when the queue runs dry and
   calls resume() on refill, -2 on a failed read.
3. Keep the one-shot path for non-Blob bodies (strings/ArrayBuffers)
   and for bundles without the seam (feature-detected at load).
4. Byte-exact regression: the #556 replay-spool harness proves 4 MiB
   bodies; extend it to a multi-chunk body larger than the wasm scratch
   buffer to prove the pause/continue path.
5. License: this fork stays AGPL-3.0 like upstream; Zeolite already
   vendors the same license.
