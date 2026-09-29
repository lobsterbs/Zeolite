/* Transport gate for the vendored libcurl seam (issue #11). Permanent
 * CI coverage of the wasm transport (CI runs no browser by design): the
 * real @mercuryworkshop/libcurl-transport 2.0.5 bundle connects to a
 * local zeolite-server wisp endpoint and runs:
 *
 *   1. unpatched: a control 301 (wikipedia), a control 200 (Hacker
 *      News) and craigslist's root - the close-delimited empty-body
 *      302 that dies with curl error 56 (RECV_ERROR) before any
 *      response object exists. Informational evidence; the h2 default
 *      and forced HTTP/1.1 fail identically (runs that diagnosed #11).
 *   2. patched: applies the same CurlSession.stream_response patch the
 *      engine applies at load time (keep in sync with
 *      app/src/libcurl-transport-vendored.ts) and re-runs craigslist:
 *      the 302 MUST surface, and the wikipedia control MUST hold.
 *      Anything else exits nonzero and fails the workflow.
 *
 * Node note: the bundled libcurl.js is an emscripten build with
 * -s ENVIRONMENT=web,worker. In Node it must be made to take the web
 * path: alias window/self/location/document (the probes for the web
 * environment), hide the process global (the probe for the node
 * environment, which asserts at load) and stub the few DOM methods the
 * runtime touches (createEvent/dispatchEvent for the runtime "load"
 * event). Node 22 already ships every web API the transport actually
 * uses: fetch, Request, Response, Headers, Blob, WebSocket. */

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
    createEvent: () => ({ initEvent() {} }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
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

/* Emscripten's node-environment probe asserts when the build has no
   node support. Hide it for the whole run; nothing in the web path or
   this script needs the process global binding. */
const savedProcess = globalThis.process;
let failures = 0;
try {
  globalThis.process = undefined;
  await runGate();
} catch (err) {
  console.log("FATAL: " + String((err && err.stack) || err));
  failures++;
} finally {
  globalThis.process = savedProcess;
}
console.log(failures ? "transport gate: FAIL" : "transport gate: PASS");
process.exit(failures ? 1 : 0);

async function runGate() {
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

  const fetchOne = async (target) => {
    const t0 = Date.now();
    try {
      const res = await client.session.fetch(target, {
        method: "GET",
        headers: { "User-Agent": UA },
        redirect: "manual",
      });
      const out = {
        target,
        ms: Date.now() - t0,
        status: res.status,
        headers: (res.raw_headers ?? []).slice(0, 12),
      };
      console.log(JSON.stringify(out));
      return out;
    } catch (err) {
      const out = { target, ms: Date.now() - t0, error: String(err) };
      console.log(JSON.stringify(out));
      return out;
    }
  };

  console.log("== unpatched (issue #11 evidence) ==");
  await fetchOne("https://en.wikipedia.org/"); // control: 301, empty body
  await fetchOne("https://news.ycombinator.com/"); // control: plain 200
  await fetchOne("https://www.craigslist.org/"); // the failing 302

  console.log("== patched (engine seam) ==");
  if (!applyEnginePatch(client.session)) {
    console.log(
      "FAIL: CurlSession.stream_response seam not found; the libcurl.js layout changed"
    );
    failures++;
    return;
  }
  const cl = await fetchOne("https://www.craigslist.org/");
  if (cl.status !== 302) {
    console.log("FAIL: patched craigslist did not surface the 302");
    failures++;
  }
  const wiki = await fetchOne("https://en.wikipedia.org/");
  if (wiki.status !== 301) {
    console.log("FAIL: patched wikipedia control regressed");
    failures++;
  }
}

/* Keep in sync with applyTransportEOF in
   app/src/libcurl-transport-vendored.ts (issue #11). */
function applyEnginePatch(session) {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(session));
  if (!proto || typeof proto.stream_response !== "function") return false;
  if (proto.__zl_eof_patched) return true;
  proto.stream_response = function (
    url,
    headers_callback,
    end_callback,
    abort_signal
  ) {
    let stream_controller;
    let aborted = false;
    let headers_received = false;
    let raw_header_text = "";
    const stream = new ReadableStream({
      start(controller) {
        stream_controller = controller;
      },
    });
    const collect_header_text = (chunk) => {
      let text = "";
      for (let i = 0; i < chunk.length; i++) {
        text += String.fromCharCode(chunk[i]);
      }
      raw_header_text += text;
    };
    const real_data_callback = (new_data) => {
      if (!headers_received) {
        headers_received = true;
        headers_callback(stream);
      }
      try {
        stream_controller.enqueue(new_data);
      } catch (e) {
        if (aborted) return;
        aborted = true;
        if (e instanceof TypeError) {
          end_callback(-1);
        } else {
          throw e;
        }
      }
    };
    const real_end_callback = (error) => {
      if (!headers_received && error === 56) {
        const lower = "\r\n" + raw_header_text.toLowerCase();
        const has_length = /(?:^|\r\n)content-length:/.test(lower);
        const length_zero = /(?:^|\r\n)content-length:\s*0(?:\r|$)/.test(
          lower
        );
        const has_chunked = /(?:^|\r\n)transfer-encoding:/.test(lower);
        if (!has_chunked && (!has_length || length_zero)) {
          headers_received = true;
          try {
            headers_callback(stream);
          } catch {}
        }
      }
      if (!headers_received && error === 0) {
        headers_received = true;
        headers_callback(stream);
      }
      try {
        stream_controller.close();
      } catch {}
      end_callback(error);
    };
    if (abort_signal instanceof AbortSignal) {
      abort_signal.addEventListener("abort", () => {
        if (aborted) return;
        aborted = true;
        if (headers_received) {
          stream_controller.error("The operation was aborted.");
        }
        real_end_callback(-1);
      });
    }
    return this.create_request(
      url,
      real_data_callback,
      real_end_callback,
      collect_header_text
    );
  };
  proto.__zl_eof_patched = true;
  return true;
}
