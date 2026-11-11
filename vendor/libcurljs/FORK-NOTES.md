# libcurl.js fork: streaming request bodies (#556)

This is a fork of ading2210/libcurl.js (0.7.5, AGPL-3.0, matching the
version Zeolite vendors) carrying one change: a streaming upload path so
large request bodies no longer have to exist as ONE contiguous buffer in
wasm memory.

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
  chunk_size) arms it (CURLOPT_UPLOAD, chunked
  INFILESIZE_LARGE = -1); http_pause(handle, bits) exposes
  curl_easy_pause so the JS side can resume a paused transfer.
- client/libcurl/request.c: the scratch buffer is freed in
  finish_request and in request_cleanup.
- client/exported_funcs.txt: http_set_upload_stream and http_pause
  exported.
- client/javascript/http.js: request_async accepts
  params.upload = { read, chunkSize }. read(bufPtr, max) is invoked
  SYNCHRONOUSLY from inside the transfer loop: write at most max bytes
  into the wasm heap at bufPtr, return the count, 0 for EOF, or -1 to
  pause the transfer. Pump an async source into a JS-side queue and
  pause when the queue runs dry, then resume with _http_pause(handle, 0)
  (CURLPAUSE_CONT) once data arrives. The function pointer is removed
  from the table in finish_callback (no table growth leak).

## Protocol notes

- The read callback stays synchronous on purpose: libcurl.js drives
  curl_multi from a non-blocking JS loop, so an async callback cannot
  block the transfer. The pause/continue protocol is the bridge.
- Chunked transfer-encoding is used (INFILESIZE -1). Servers that
  reject chunked bodies need a known length; a future option can pass
  INFILESIZE explicitly.
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

1. Point the vendored bundle at this fork's build output.
2. app/src/request.ts: replace the one-shot body read with a
   queue-backed read callback wired to the spool (the #556 curl read
   callback item), pausing on backpressure.
3. Keep the one-shot path for small bodies (under one chunk) to avoid
   regressing the common case.
4. Byte-exact regression: the #556 replay-spool harness already proves
   4 MiB bodies; extend it to a multi-chunk body larger than the wasm
   buffer to prove the pause/continue path.
5. License: this fork stays AGPL-3.0 like upstream; Zeolite already
   vendors the same license.
