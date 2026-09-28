/* Replay harness (2.5 Iodide): re-issue the destination URLs of a
   recorded session (zlRecord artifact, see app/src/recording.ts)
   against a running engine and compare the stable facts.

   The 1.9 version replayed through HTTP fetches to
   ${BASE}/j/<b64url>, a route zeolite-server has never had (it is a
   wisp relay: /wisp/ plus a static fallback), so a replay could only
   ever have produced 404 fails. This version re-issues each recorded
   GET over a real wisp v2.1 session: CONNECT to the resolved fixture
   host, one raw HTTP/1.1 request per stream, redirect hops followed
   manually (the SW follows them too; that is why redirect chains are
   recorded with final statuses). Bodies, headers and timings are
   deliberately NOT compared - they were never recorded (secrets,
   size) and they are not stable across runs. Compared facts: the
   status class of the final response. The unrewritten-URL check of
   the old harness is gone: rewriting fidelity is client-side SW
   behavior, covered by the app unit suite, not observable from a
   node probe.

   The WebSocket-lifecycle and cookie-jar-shape sections of the
   artifact join the comparison (shipped in 5b7e768 ahead of the 2.5
   cut). Client-runtime behavior (the SW ws bridge, the SW jar) is not
   reachable from a plain HTTP replay, so these compare the recorded
   facts against the artifact contract: ws events are direction-only
   (kind from the known set, absolute ws(s):// target URLs, never
   engine routes, never payloads) and cookie entries are shape-only
   (origin, name, domain, path; never values). A recording regression
   - payload capture, value leak, route leak - fails replay instead of
   shipping silently.

   Usage:
     node suite/replay.mjs --base http://localhost:6002 \
       --session suite/sessions/fixture.session.json --fixture

   With --fixture, the token %FIXTURE% inside session destination URLs
   is replaced by the live fixture's loopback host:port (started on a
   random loopback port), so the checked-in session stays
   port-independent. Requires the engine to allow loopback upstreams
   (ZL_TEST_ALLOW_PRIVATE_DESTS=1, compat job only). */

import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { wispSession, streamRequest, statusLine, reasonName } from "./wisp.mjs";
import { startFixtureServer } from "./fixtures.mjs";

const arg = (name, fallback) =>
  process.argv.includes("--" + name) ? process.argv[process.argv.indexOf("--" + name) + 1] : fallback;

const BASE = arg("base", "http://localhost:6002");
const SESSION = arg("session", "suite/sessions/fixture.session.json");
const useFixture = process.argv.includes("--fixture");

let fixture = null;
if (useFixture) fixture = await startFixtureServer();

const session = JSON.parse(readFileSync(SESSION, "utf8"));
if (session.format !== "zlRecord") {
  console.error("not a zlRecord session: " + (session.format ?? "(none)"));
  process.exit(1);
}

const resolve = (dest) =>
  fixture ? dest.replaceAll("%FIXTURE%", `127.0.0.1:${fixture.port}`) : dest;

const wisp = await wispSession(BASE);

const rawGet = (host, port, path) =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: zeolite-compat/2.5\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

/* One recorded GET: CONNECT, request, follow 3xx Location hops like the
   SW does (bounded 8, engine routes cannot appear - they are not
   reachable over raw TCP), return the final status. */
async function replayGet(dest) {
  const url = new URL(dest);
  const host = url.hostname;
  const port = url.port || "80";
  let path = url.pathname + url.search;
  for (let hop = 0; hop < 8; hop++) {
    const resp = await streamRequest(wisp, host, parseInt(port, 10), rawGet(host, port, path));
    if (resp.bytes.length === 0) {
      return { status: null, note: "no data, close " + reasonName(resp.closeReason) };
    }
    const status = statusLine(resp);
    if (status === null) {
      return { status: null, note: "response not parseable as HTTP" };
    }
    if (status >= 300 && status < 400) {
      const headEnd = resp.bytes.indexOf(Buffer.from("\r\n\r\n", "latin1"));
      const head = resp.bytes.subarray(0, headEnd < 0 ? resp.bytes.length : headEnd).toString("latin1");
      const loc = /location:\s*(\S+)/i.exec(head);
      if (!loc) return { status, note: "3xx without Location" };
      const next = new URL(loc[1], `http://${host}:${port}`);
      if (next.hostname !== host || next.port !== port) {
        return { status, note: "redirect off the fixture origin: " + loc[1] };
      }
      path = next.pathname + next.search;
      continue;
    }
    return { status, note: `status ${status}${hop ? ` after ${hop} redirect hop(s)` : ""}` };
  }
  return { status: null, note: "redirect chain exceeded 8 hops" };
}

const results = [];
for (const req of session.requests ?? []) {
  const out = { seq: req.seq, dest: req.dest, verdict: "skip", note: "" };
  if (req.method !== "GET") {
    out.note = "non-GET requests carry no recorded body; skipped";
    results.push(out);
    continue;
  }
  try {
    const live = await replayGet(resolve(req.dest));
    const recordedClass = Math.floor((req.status ?? 0) / 100);
    const liveClass = Math.floor((live.status ?? 0) / 100);
    if (live.status === null) {
      out.verdict = "fail";
      out.note = live.note;
    } else if (recordedClass !== liveClass) {
      out.verdict = "fail";
      out.note = `status class changed: recorded ${req.status}, live ${live.status} (${live.note})`;
    } else {
      out.verdict = "pass";
      out.note = live.note;
    }
  } catch (e) {
    out.verdict = "fail";
    out.note = e.message;
  }
  results.push(out);
  process.stdout.write(`replay seq ${req.seq}: ${out.verdict} (${out.note})\n`);
}

wisp.close();

/* Artifact contract: ws events direction-only, cookies shape-only. */
const WS_KINDS = new Set(["open", "error", "tx", "rx", "upgrade", "close"]);
const wsIssues = [];
for (const ev of session.websockets ?? []) {
  const url = resolve(ev.url ?? "");
  if (!WS_KINDS.has(ev.kind)) {
    wsIssues.push(`ws seq ${ev.seq}: unknown kind ${JSON.stringify(ev.kind)}`);
  }
  if ("data" in ev || "payload" in ev) {
    wsIssues.push(`ws seq ${ev.seq}: payload captured`);
  }
  if (!/^wss?:\/\//.test(url)) {
    wsIssues.push(`ws seq ${ev.seq}: not an absolute ws(s) URL: ${url}`);
  } else if (/\/j\/[A-Za-z0-9_-]{20,}/.test(url)) {
    wsIssues.push(`ws seq ${ev.seq}: engine route leaked into the ws record`);
  }
}
const cookieIssues = [];
for (const c of session.cookies ?? []) {
  if (!c.origin || !c.name || !c.domain || !c.path) {
    cookieIssues.push(`cookie ${JSON.stringify(c.name ?? "?")}: missing shape field`);
  }
  if ("value" in c) {
    cookieIssues.push(`cookie ${c.name}: value captured`);
  }
}
for (const issue of wsIssues) process.stdout.write("replay ws: " + issue + "\n");
for (const issue of cookieIssues) process.stdout.write("replay cookie: " + issue + "\n");

if (fixture) fixture.server.close();

const fails = results.filter((r) => r.verdict === "fail");
const artifactFails = wsIssues.length + cookieIssues.length;
const report = {
  base: BASE,
  transport: "wisp v2.1 over /wisp/",
  session: SESSION,
  replayed: results.length,
  passed: results.filter((r) => r.verdict === "pass").length,
  failed: fails.length,
  skipped: results.filter((r) => r.verdict === "skip").length,
  websockets: (session.websockets ?? []).length,
  wsIssues,
  cookies: (session.cookies ?? []).length,
  cookieIssues,
  results,
};
writeFileSync("suite/replay-report.json", JSON.stringify(report, null, 2));
process.exit(fails.length + artifactFails ? 1 : 0);
