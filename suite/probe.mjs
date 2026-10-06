/* Compat suite (2.5 Iodide): real-site probes through the REAL
   transport. The 1.9 version of this file fetched
   ${BASE}/j/<b64url> as if zeolite-server exposed an HTTP proxy
   route. It never had one: the server is a wisp relay (exactly /wisp/
   plus a static fallback) and all rewriting happens client-side in
   the service worker, so those probes 404'd on the first run that
   ever executed (36472949276) and the issues it auto-filed were
   harness false alarms. This version probes what actually ships: a
   wisp v2.1 session, CONNECT to site:80, one raw HTTP/1.1 request,
   first-byte and total time, versus the same raw request over a
   direct socket. Rewriting fidelity stays covered by the app unit
   suite (vitest) and the wasm job; it is not observable from a node
   probe and is never claimed here.

   Report-only: probe failures never gate the run; the compat job
   files one deduplicated issue per failing site. Failures must become
   SiteConfig rules + a probe test, never a hardcoded engine hack.
   Usage: node suite/probe.mjs --base http://localhost:6002 */

import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { connect as tcpConnect } from "node:net";
import { wispSession, streamRequest, statusLine, reasonName } from "./wisp.mjs";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:6002";

const SITES = [
  { name: "youtube", host: "www.youtube.com" },
  { name: "reddit", host: "www.reddit.com" },
  { name: "wikipedia", host: "en.wikipedia.org" },
  { name: "github", host: "github.com" },
  { name: "discord", host: "discord.com" },
  // Issue #81: google probes, report-only. Raw-HTTP rows only; the
  // browser-level rows the issue lists (image results, XHR tiles,
  // the SW registration shim) need a real browser, which this
  // suite forbids by design; those stay covered by the app unit
  // suite, never claimed here.
  { name: "google-home", host: "www.google.com", path: "/" },
  { name: "google-search", host: "www.google.com", path: "/search?q=test" },
  { name: "google-consent", host: "consent.google.com", path: "/" },
];

const rawGet = (host, path = "/") =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: zeolite-compat/2.6\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

/* Direct baseline: the same raw request over a plain socket. */
function directProbe(host, path = "/") {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ttfb = null;
    let buf = Buffer.alloc(0);
    const finish = (error) => {
      const status = buf.length ? statusLine({ bytes: buf }) : null;
      resolve({ ttfb, status, error: error ?? (status === null ? "no response parsed" : null) });
    };
    const sock = tcpConnect(80, host);
    sock.setTimeout(15000, () => {
      sock.destroy();
      finish("direct timeout");
    });
    sock.on("error", (e) => {
      finish("direct: " + e.message);
    });
    sock.on("connect", () => sock.write(rawGet(host, path)));
    sock.on("data", (c) => {
      if (ttfb === null) ttfb = Math.round(performance.now() - t0);
      buf = Buffer.concat([buf, c]);
    });
    sock.on("close", () => finish(null));
  });
}

/* Issue #81: honest failure categories. A failure the direct
   baseline also sees (site gating: consent redirects, 403/429/451
   against datacenter IPs) is an egress-gate, not an engine defect;
   only direct-works-engine-fails rows are client defects. */
function failureCategory(r) {
  const d = r.statusDirect ?? 0;
  const gated = (d >= 300 && d < 400) || d === 403 || d === 429 || d === 451;
  return gated ? "egress-gate" : "client-defect";
}

const session = await wispSession(BASE);

const results = [];
for (const site of SITES) {
  process.stdout.write(`probing ${site.name}... `);
  const r = {
    name: site.name,
    status: "fail",
    ttfbDirect: null,
    ttfbProxy: null,
    ratio: null,
    statusDirect: null,
    statusProxy: null,
    error: null,
  };
  const direct = await directProbe(site.host, site.path ?? "/");
  r.ttfbDirect = direct.ttfb;
  r.statusDirect = direct.status;
  if (direct.error) r.error = direct.error;
  try {
    const t0 = performance.now();
    const resp = await streamRequest(session, site.host, 80, rawGet(site.host, site.path ?? "/"), {
      first: () => {
        if (r.ttfbProxy === null) r.ttfbProxy = Math.round(performance.now() - t0);
      },
    });
    if (resp.bytes.length === 0) {
      r.error = (r.error ? r.error + "; " : "") + "engine stream closed with no data: " + reasonName(resp.closeReason);
    } else {
      r.statusProxy = statusLine(resp);
      if (r.statusProxy === null) {
        r.error = (r.error ? r.error + "; " : "") + "engine response not parseable as HTTP";
      } else if (direct.status !== null && Math.floor(r.statusProxy / 100) !== Math.floor(direct.status / 100)) {
        r.error = (r.error ? r.error + "; " : "") + `status class differs: direct ${direct.status}, engine ${r.statusProxy}`;
      } else {
        r.status = "pass";
      }
    }
  } catch (e) {
    r.error = (r.error ? r.error + "; " : "") + "engine probe failed: " + e.message;
  }
  if (r.status !== "pass") r.category = failureCategory(r);
  process.stdout.write(r.status + "\n");
  results.push(r);
}

/* Issue #79: follow the consent.google.com redirect chain through
   the engine and record each hop's Set-Cookie headers. Report-only;
   raw HTTP only, no browser, per suite policy. */
const consentHops = [];
try {
  let hop = { host: "consent.google.com", path: "/" };
  for (let i = 0; i < 4 && hop; i++) {
    const resp = await streamRequest(session, hop.host, 80, rawGet(hop.host, hop.path), {});
    const text = resp.bytes.toString("latin1");
    const head = text.slice(0, text.indexOf("\r\n\r\n") + 4);
    const status = statusLine(resp);
    const headers = head.split("\r\n");
    const setCookie = headers.filter((l) => /^set-cookie:/i.test(l));
    consentHops.push({ ...hop, status, setCookie });
    const loc = headers.find((l) => /^location:/i.test(l));
    if (status && Math.floor(status / 100) === 3 && loc) {
      const target = loc.slice(loc.indexOf(":") + 1).trim();
      const u = new URL(target, `http://${hop.host}`);
      hop = { host: u.host, path: u.pathname + u.search };
    } else {
      hop = null;
    }
  }
} catch (e) {
  consentHops.push({ error: "consent chain probe failed: " + e.message });
}

session.close();

const passed = results.filter((r) => r.status === "pass").length;
const scoreboard = {
  base: BASE,
  transport: "wisp v2.1 over /wisp/ (raw HTTP/1.1 on port 80)",
  generated: new Date().toISOString(),
  summary: { pass: passed, total: results.length },
  consentChain: consentHops,
  results: results.map((r) => ({
    ...r,
    ratio: r.ttfbDirect && r.ttfbProxy ? +(r.ttfbProxy / r.ttfbDirect).toFixed(2) : null,
  })),
};
writeFileSync("suite/scoreboard.json", JSON.stringify(scoreboard, null, 2));

const md = [
  "# Zeolite compat scoreboard",
  "",
  `Generated: ${scoreboard.generated}`,
  `Engine: ${BASE} - wisp v2.1 transport, raw HTTP/1.1 on port 80`,
  "",
  "| site | status | ttfb direct | ttfb proxy | ratio | status d/p | cat | notes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...scoreboard.results.map(
    (r) =>
      `| ${r.name} | ${r.status === "pass" ? "PASS" : "FAIL"} | ${r.ttfbDirect ?? "-"}ms | ${r.ttfbProxy ?? "-"}ms | ${r.ratio ?? "-"}x | ${r.statusDirect ?? "-"}/${r.statusProxy ?? "-"} | ${r.category ?? "-"} | ${(r.error ?? "").replace(/\|/g, "/")} |`
  ),
  "",
  "## consent.google.com redirect chain (issue #79, report-only)",
  "",
  ...consentHops.map(
    (h) =>
      `- ${h.host ?? "?"}${h.path ?? ""}: status ${h.status ?? "-"}, set-cookie x${(h.setCookie ?? []).length}${h.error ? " - " + h.error : ""}`
  ),
  "",
  "Report-only since 2.5 Iodide: failures open issues, they never gate",
  "(flaky external targets must not break CI).",
  "",
].join("\n");
writeFileSync("suite/scoreboard.md", md);

/* 2.5 Iodide: real-site results never gate the run. Flaky external
   targets must not break CI; failures are recorded in the JSON and the
   compat job files one deduplicated issue per failing site. */
process.exit(0);
