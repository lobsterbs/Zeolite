/* Replay harness (Phase 9, 1.9 Fullerene): re-issue the destination
   URLs of a recorded session (zlRecord artifact, see
   app/src/recording.ts) against a running engine and compare the
   stable facts. This is the regression harness for engine changes:
   record a session, keep the artifact in the repo, replay it nightly.

   Bodies, headers and timings are deliberately NOT compared - they
   were never recorded (secrets, size) and they are not stable across
   runs. Compared facts: reachability, status class, and (for HTML)
   the absence of unrewritten absolute href/src attributes.

   Usage:
     node suite/replay.mjs --base http://localhost:6002 \
       --session suite/sessions/fixture.session.json --fixture

   With --fixture, the token %FIXTURE% inside session destination
   URLs is replaced by a live deterministic fixture origin (started
   on a random loopback port), so the checked-in session stays
   port-independent. Requires the engine to allow loopback upstreams
   (ZL_TEST_ALLOW_PRIVATE_DESTS=1, nightly compat job only). */

import { readFileSync, writeFileSync } from "node:fs";
import { b64uEncode } from "./codec.mjs";
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

const resolve = (dest) => (fixture ? dest.replaceAll("%FIXTURE%", fixture.origin) : dest);
const engine = (url) => `${BASE}/j/${b64uEncode(new TextEncoder().encode(url))}`;

const results = [];
for (const req of session.requests ?? []) {
  const out = { seq: req.seq, dest: req.dest, verdict: "skip", note: "" };
  if (req.method !== "GET") {
    out.note = "non-GET requests carry no recorded body; skipped";
    results.push(out);
    continue;
  }
  const url = resolve(req.dest);
  try {
    const resp = await fetch(engine(url), { redirect: "follow" });
    const recordedClass = Math.floor((req.status ?? 0) / 100);
    const liveClass = Math.floor(resp.status / 100);
    if (recordedClass !== liveClass) {
      out.verdict = "fail";
      out.note = `status class changed: recorded ${req.status}, live ${resp.status}`;
    } else {
      out.verdict = "pass";
      out.note = `status ${resp.status}`;
    }
    /* HTML responses additionally must not leak unrewritten absolute
       URLs - the same regression marker the site probes assert. */
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (out.verdict === "pass" && ct.includes("text/html")) {
      const text = await resp.text();
      const bad = [...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((v) => /^https?:\/\//i.test(v) && !v.startsWith(BASE));
      if (bad.length) {
        out.verdict = "fail";
        out.note = "unrewritten absolute URLs: " + bad.slice(0, 2).join(", ");
      }
    }
  } catch (e) {
    out.verdict = "fail";
    out.note = e.message;
  }
  results.push(out);
  process.stdout.write(`replay seq ${req.seq}: ${out.verdict} (${out.note})\n`);
}

if (fixture) fixture.server.close();

const fails = results.filter((r) => r.verdict === "fail");
const report = {
  base: BASE,
  session: SESSION,
  replayed: results.length,
  passed: results.filter((r) => r.verdict === "pass").length,
  failed: fails.length,
  skipped: results.filter((r) => r.verdict === "skip").length,
  results,
};
writeFileSync("suite/replay-report.json", JSON.stringify(report, null, 2));
process.exit(fails.length ? 1 : 0);
