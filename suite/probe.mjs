/* Compat suite: nightly probes through a running Zeolite engine,
   compared against direct access. Produces scoreboard.json and
   scoreboard.md. Report-only since 2.5 Iodide: probe failures never
   gate the run; the compat job opens one deduplicated issue per
   failing site instead. Failures must become SiteConfig rules + a
   probe test, never a hardcoded hack in the engine.
   Usage: node suite/probe.mjs --base https://jet.example.com */

import { writeFileSync } from "node:fs";
import { b64uEncode } from "./codec.mjs";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:6002";

const SITES = [
  { name: "youtube", url: "https://www.youtube.com/", interactive: true },
  { name: "reddit", url: "https://www.reddit.com/", interactive: true },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Lobster", interactive: false },
  { name: "github", url: "https://github.com/", interactive: false },
  { name: "discord", url: "https://discord.com/", attempt: true, interactive: false },
];

/** Measure time-to-first-byte and first-paint proxy (HTML head arrival). */
async function probe(site) {
  const result = { name: site.name, status: "fail", ttfbDirect: null, ttfbProxy: null, failingSubresources: [], error: null };
  const encoded = `${BASE}/j/${b64uEncode(new TextEncoder().encode(site.url))}`;

  try {
    // Direct baseline.
    const t0 = performance.now();
    await fetch(site.url, { redirect: "follow" });
    result.ttfbDirect = Math.round(performance.now() - t0);
  } catch (e) {
    result.error = "direct baseline failed: " + e.message;
  }

  try {
    const t0 = performance.now();
    const resp = await fetch(encoded, { redirect: "follow" });
    const reader = resp.body.getReader();
    await reader.read(); // first chunk = first paint proxy
    result.ttfbProxy = Math.round(performance.now() - t0);
    // Drain and check basic rewrite markers.
    let page = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      page += new TextDecoder().decode(value, { stream: true });
    }
    // No unrewritten absolute URL may survive in href/src attributes.
    const attrUrls = [...page.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((v) => /^https?:\/\//i.test(v) && !v.startsWith(BASE));
    if (resp.status >= 400) {
      result.error = "proxy status " + resp.status;
    } else if (attrUrls.length > 0) {
      result.error = "unrewritten absolute URLs: " + attrUrls.slice(0, 3).join(", ");
    } else {
      result.status = "pass";
    }
  } catch (e) {
    result.error = (result.error ? result.error + "; " : "") + "proxy fetch failed: " + e.message;
  }

  result.ratio = result.ttfbDirect && result.ttfbProxy
    ? +(result.ttfbProxy / result.ttfbDirect).toFixed(2)
    : null;
  return result;
}

const results = [];
for (const site of SITES) {
  process.stdout.write(`probing ${site.name}... `);
  const r = await probe(site);
  process.stdout.write(r.status + "\n");
  results.push(r);
}

const passed = results.filter((r) => r.status === "pass").length;
const scoreboard = {
  base: BASE,
  generated: new Date().toISOString(),
  summary: { pass: passed, total: results.length },
  results,
};
writeFileSync("suite/scoreboard.json", JSON.stringify(scoreboard, null, 2));

const md = [
  "# Zeolite compat scoreboard",
  "",
  `Generated: ${scoreboard.generated}`,
  `Engine: ${BASE}`,
  "",
  "| site | status | ttfb direct | ttfb proxy | ratio | notes |",
  "| --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.status === "pass" ? "PASS" : "FAIL"} | ${r.ttfbDirect ?? "-"}ms | ${r.ttfbProxy ?? "-"}ms | ${r.ratio ?? "-"}x | ${r.error ?? ""} |`
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
