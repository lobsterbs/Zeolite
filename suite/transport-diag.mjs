/* One-shot transport diagnostic for issue #11. Not part of the
   compat suite: delete when the issue closes.
 *
 * Connects @mercuryworkshop/libcurl-transport 2.0.5 to a local
 * zeolite-server wisp endpoint and fetches a control 301 (wikipedia),
 * a control 200 (Hacker News) and craigslist's root (the failing
 * empty-body 302 from #11), once with the transport's defaults
 * (h2 via ALPN, redirect: manual) and once forcing HTTP/1.1 through
 * the request params JSON (_libcurl_http_version + _libcurl_verbose,
 * parsed by libcurl.js http.c http_set_options, which
 * HTTPSession.fetch passes through wholesale).
 *
 * The #11 analysis: the transport rejects with curl error 56
 * (RECV_ERROR) on craigslist's 302 before any response object
 * exists. If the h1 variant returns a real 302, the failure is in
 * the h2 delivery path; if it fails identically, the fault is in
 * close-delimited EOF handling of the wisp socket layer.
 *
 * Node note: libcurl.js's emscripten prelude throws "environment
 * detection error" unless it sees a worker (importScripts) or a
 * window. Node 22 already ships every web API the transport touches
 * (fetch, Request, Response, Headers, Blob, WebSocket), so alias the
 * globals the prelude probes instead of running a real browser. */

globalThis.window = globalThis;
globalThis.self = globalThis;
if (typeof globalThis.location === "undefined") {
  globalThis.location = {
    href: "http://127.0.0.1/",
    origin: "http://127.0.0.1",
    protocol: "http:",
    host: "127.0.0.1",
    hostname: "127.0.0.1",
    port: "",
    pathname: "/",
    search: "",
    hash: "",
  };
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    currentScript: { src: "http://127.0.0.1/" },
    getElementsByTagName: () => [],
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
    }),
    addEventListener() {},
    removeEventListener() {},
  };
}
if (typeof globalThis.CloseEvent === "undefined") {
  globalThis.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.code = init.code ?? 1005;
      this.reason = init.reason ?? "";
      this.wasClean = init.wasClean ?? true;
    }
  };
}

const WISP = "ws://127.0.0.1:6002/wisp/";

if (typeof WebSocket === "undefined") {
  const ws = await import("ws");
  globalThis.WebSocket = ws.WebSocket ?? ws.default;
}

const { LibcurlClient } = await import(
  "@mercuryworkshop/libcurl-transport"
);
const client = new LibcurlClient({ wisp: WISP });
await client.init();

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like " +
  "Gecko) Chrome/131.0.0.0 Safari/537.36";

const targets = [
  "https://en.wikipedia.org/", // control: 301, empty body
  "https://news.ycombinator.com/", // control: plain 200
  "https://www.craigslist.org/", // the failing 302 from #11
];

const variants = {
  default: {},
  h1: { _libcurl_http_version: 1.1, _libcurl_verbose: 1 },
};

for (const target of targets) {
  for (const [variant, extra] of Object.entries(variants)) {
    const t0 = Date.now();
    try {
      const res = await client.session.fetch(target, {
        method: "GET",
        headers: { "User-Agent": UA },
        redirect: "manual",
        ...extra,
      });
      console.log(
        JSON.stringify({
          target,
          variant,
          ms: Date.now() - t0,
          status: res.status,
          headers: (res.raw_headers ?? []).slice(0, 12),
        })
      );
    } catch (err) {
      console.log(
        JSON.stringify({
          target,
          variant,
          ms: Date.now() - t0,
          error: String(err),
        })
      );
    }
  }
}
