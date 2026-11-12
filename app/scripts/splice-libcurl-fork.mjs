#!/usr/bin/env node
/* #556: splice the forked libcurl.js single-file build into the served
   @mercuryworkshop/libcurl-transport bundle.

   The vendored artifact (app/public/libcurl/index.mjs) is the npm
   transport dist: an esbuild bundle of [libcurl.js libcurl_full.mjs as
   "var libcurl = function() {...}();"] + [the LibcurlClient client,
   introduced by "// src/main.ts"] + a trailing export block. The fork
   (#556, branch libcurljs-fork) rebuilds ONLY the libcurl.js layer
   (streaming upload seam); the client layer is unchanged. This script
   replaces the embedded libcurl.js layer with the fork build:

     prelude (up to the embedded-module marker comment)
     fork libcurl_full.mjs with "export const libcurl =" -> "var libcurl ="
     client layer (from "// src/main.ts" to EOF, verbatim)

   The adapter (src/libcurl-transport-vendored.ts) evaluates the bundle
   body with a Function constructor and returns LibcurlClient, so the
   spliced file must contain no export statements and must define both
   libcurl and LibcurlClient in scope. Every step asserts; any drift
   fails loudly instead of serving a broken bundle.

   Usage: node splice-libcurl-fork.mjs <stock-index.mjs> <fork-libcurl_full.mjs> <out>
*/
import fs from 'fs';

const [stockPath, forkPath, outPath] = process.argv.slice(2);
if (!stockPath || !forkPath || !outPath) {
  console.error('usage: node splice-libcurl-fork.mjs <stock-index.mjs> <fork-libcurl_full.mjs> <out>');
  process.exit(2);
}
const SEAM_EXPORTS = [
  '_http_get_info',
  '_http_set_options',
  '_http_set_cookie_jar',
  '_http_set_upload_stream',
  '_http_pause',
];
const EMBED_MARKER = '// node_modules/.pnpm/libcurl.js@';
const CLIENT_MARKER = '// src/main.ts';
const FORK_HEADER = 'export const libcurl = (function() {';

const stock = fs.readFileSync(stockPath, 'utf8');
const fork = fs.readFileSync(forkPath, 'utf8');

const fail = (msg) => {
  console.error('splice-libcurl-fork: ' + msg);
  process.exit(1);
};

const embedAt = stock.indexOf(EMBED_MARKER);
const clientAt = stock.indexOf(CLIENT_MARKER);
if (embedAt < 0) fail('stock bundle has no embedded-module marker');
if (clientAt < 0) fail('stock bundle has no client marker');
if (stock.indexOf(EMBED_MARKER, embedAt + 1) >= 0) fail('embedded-module marker is not unique');
if (stock.indexOf(CLIENT_MARKER, clientAt + 1) >= 0) fail('client marker is not unique');
if (clientAt <= embedAt) fail('client marker precedes embedded-module marker');

const forkHeaderAt = fork.indexOf(FORK_HEADER);
if (forkHeaderAt < 0) fail('fork bundle does not open with the expected export header');
if (fork.indexOf(FORK_HEADER, forkHeaderAt + 1) >= 0) fail('fork export header is not unique');
if (/^export /m.test(fork.replace(FORK_HEADER, ''))) fail('fork bundle carries a second export statement');
for (const seam of SEAM_EXPORTS) {
  if (!fork.includes(seam)) fail('fork bundle is missing seam export ' + seam);
}

const splicedFork = fork.replace(FORK_HEADER, 'var libcurl = (function() {');
const out =
  stock.slice(0, embedAt) +
  splicedFork +
  '\n' +
  stock.slice(clientAt);

if (out.includes('export const libcurl')) fail('spliced output still exports libcurl');
if ((out.match(/var libcurl = /g) || []).length !== 1) fail('spliced output does not define var libcurl exactly once');
if (!out.includes('var LibcurlClient = class')) fail('spliced output lost the LibcurlClient class');
for (const seam of SEAM_EXPORTS) {
  if (!out.includes(seam)) fail('spliced output lost seam export ' + seam);
}
if (out.length <= fork.length) fail("spliced output lost the client layer");

fs.writeFileSync(outPath, out);
console.log('splice-libcurl-fork: wrote ' + outPath + ' (' + out.length + ' B; stock ' + stock.length + ' B; fork ' + fork.length + ' B)');
