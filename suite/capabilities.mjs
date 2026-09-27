/* Capability probes (Phase 9, 1.9 Fullerene): per-capability scoreboard
   over the server path, against a deterministic local fixture origin.
   Verdicts are facts, never invented percentages. Capabilities that
   live in the client runtime (WebSocket bridge, worker virtualization,
   storage, Cache API, client cookie jars, SPA routing) are marked
   client-runtime: they are covered by the app unit suite and session
   recording, and are honestly NOT probed here - a plain HTTP probe
   cannot execute page JavaScript.

   Gated capabilities (gate: true) fail the run; the rest are
   report-only so the nightly scoreboard surfaces reality without
   pretending. Failures must become fixes, never quiet score tuning.

   Usage: node suite/capabilities.mjs --base http://localhost:6002
   Writes suite/capabilities.json and suite/capabilities.md. */

import { writeFileSync } from "node:fs";
import { b64uEncode } from "./codec.mjs";
import { MEDIA, startFixtureServer } from "./fixtures.mjs";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:6002";

const engine = (url) => `${BASE}/j/${b64uEncode(new TextEncoder().encode(url))}`;

const { server, origin } = await startFixtureServer();

const caps = [];
const check = async (name, gate, fn) => {
  let status = "fail";
  let note = "";
  try {
    const r = await fn();
    status = r.ok ? "pass" : "fail";
    note = r.note ?? "";
  } catch (e) {
    note = e.message;
  }
  caps.push({ name, gate, status, note });
  process.stdout.write(`${name}: ${status}${note ? " (" + note + ")" : ""}\n`);
};

const bodyOf = async (resp) => {
  const buf = await resp.arrayBuffer();
  return { text: new TextDecoder().decode(buf), bytes: Buffer.from(buf) };
};

const unrewrittenAttrs = (html) =>
  [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(origin));

await check("html-links", true, async () => {
  const resp = await fetch(engine(`${origin}/page.html`));
  const { text } = await bodyOf(resp);
  const bad = unrewrittenAttrs(text);
  if (resp.status !== 200) return { ok: false, note: "status " + resp.status };
  if (!text.includes("opaque blob")) return { ok: false, note: "page body wrong" };
  return bad.length ? { ok: false, note: "unrewritten: " + bad.slice(0, 2).join(", ") } : { ok: true };
});

await check("opaque-urls", true, async () => {
  const resp = await fetch(engine(`${origin}/page.html`));
  const { text } = await bodyOf(resp);
  return text.includes(`blob:${origin}/uuid`) && text.includes('href="data:text/plain,hello"')
    ? { ok: true }
    : { ok: false, note: "blob/data hrefs were touched" };
});

await check("css-urls", false, async () => {
  const resp = await fetch(engine(`${origin}/style.css`));
  const { text } = await bodyOf(resp);
  return text.includes(`url(${origin}/`) || text.includes(`url("${origin}/`)
    ? { ok: false, note: "css url() not rewritten" }
    : { ok: true };
});

await check("js-serve", true, async () => {
  const resp = await fetch(engine(`${origin}/app.js`));
  const { text } = await bodyOf(resp);
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (resp.status !== 200) return { ok: false, note: "status " + resp.status };
  if (!ct.includes("javascript")) return { ok: false, note: "content-type " + ct };
  return text.includes("stable-marker-7f3a") ? { ok: true } : { ok: false, note: "marker missing" };
});

await check("fetch-get", true, async () => {
  const resp = await fetch(engine(`${origin}/page2`));
  const { text } = await bodyOf(resp);
  return resp.status === 200 && text.includes("page-two-marker")
    ? { ok: true }
    : { ok: false, note: "status " + resp.status };
});

await check("fetch-post", true, async () => {
  const resp = await fetch(engine(`${origin}/echo`), { method: "POST", body: "ping" });
  const { text } = await bodyOf(resp);
  return text === "echo:ping" ? { ok: true } : { ok: false, note: "echo mismatch: " + text.slice(0, 40) };
});

await check("iframe-src", false, async () => {
  const resp = await fetch(engine(`${origin}/page.html`));
  const { text } = await bodyOf(resp);
  const m = text.match(/<iframe[^>]*src=["']([^"']+)["']/);
  return m && !m[1].startsWith(origin) ? { ok: true } : { ok: false, note: "iframe src not rewritten" };
});

await check("redirect-301", false, async () => {
  const resp = await fetch(engine(`${origin}/redirect301`));
  const { text } = await bodyOf(resp);
  return resp.status === 200 && text.includes("page-two-marker") ? { ok: true } : { ok: false, note: "status " + resp.status };
});

await check("redirect-302", false, async () => {
  const resp = await fetch(engine(`${origin}/redirect302`));
  const { text } = await bodyOf(resp);
  return resp.status === 200 && !text.includes(origin) ? { ok: true } : { ok: false, note: "status " + resp.status };
});

await check("redirect-307", false, async () => {
  const resp = await fetch(engine(`${origin}/redirect307`));
  const { text } = await bodyOf(resp);
  return resp.status === 200 && text.includes("stable-marker-7f3a") ? { ok: true } : { ok: false, note: "status " + resp.status };
});

await check("download-attachment", false, async () => {
  const resp = await fetch(engine(`${origin}/download`));
  const { bytes } = await bodyOf(resp);
  const cd = resp.headers.get("content-disposition") ?? "(absent)";
  return bytes.equals(MEDIA) ? { ok: true, note: "content-disposition: " + cd } : { ok: false, note: "bytes differ" };
});

await check("media-bytes", false, async () => {
  const resp = await fetch(engine(`${origin}/media.bin`));
  const { bytes } = await bodyOf(resp);
  const ct = resp.headers.get("content-type") ?? "(absent)";
  return bytes.equals(MEDIA) && ct.includes("video") ? { ok: true, note: ct } : { ok: false, note: "bytes/type differ" };
});

await check("error-404", false, async () => {
  const resp = await fetch(engine(`${origin}/missing`));
  return resp.status === 404 ? { ok: true } : { ok: false, note: "status " + resp.status };
});

await check("error-500", false, async () => {
  const resp = await fetch(engine(`${origin}/boom`));
  return resp.status === 500 ? { ok: true } : { ok: false, note: "status " + resp.status };
});

await check("set-cookie-header", false, async () => {
  const resp = await fetch(engine(`${origin}/setcookie`));
  const sc = resp.headers.get("set-cookie") ?? "(absent)";
  return { ok: resp.status === 200, note: "server path set-cookie: " + sc };
});

/* Client-runtime capabilities: honestly not probeable over plain
   HTTP. Listed so the scoreboard states coverage instead of
   inventing a result. */
for (const name of ["websocket-bridge", "worker-virtualization", "storage-virtualization", "cache-api", "client-cookie-jars", "spa-routing"]) {
  caps.push({ name, gate: false, status: "client-runtime", note: "covered by app unit tests + session recording; not executable from an HTTP probe" });
}

server.close();

const gatedFails = caps.filter((c) => c.gate && c.status !== "pass");
const scoreboard = {
  base: BASE,
  fixture: origin,
  generated: new Date().toISOString(),
  summary: {
    pass: caps.filter((c) => c.status === "pass").length,
    fail: caps.filter((c) => c.status === "fail").length,
    clientRuntime: caps.filter((c) => c.status === "client-runtime").length,
    total: caps.length,
  },
  capabilities: caps,
};
writeFileSync("suite/capabilities.json", JSON.stringify(scoreboard, null, 2));

const md = [
  "# Zeolite capability scoreboard",
  "",
  `Generated: ${scoreboard.generated}`,
  `Engine: ${BASE} - fixture: ${origin}`,
  "",
  "| capability | gate | status | notes |",
  "| --- | --- | --- | --- |",
  ...caps.map((c) => `| ${c.name} | ${c.gate ? "yes" : "report"} | ${c.status.toUpperCase()} | ${(c.note ?? "").replace(/\|/g, "/")} |`),
  "",
  "Gated capabilities fail the nightly run; report-only ones surface reality without gating.",
  "Client-runtime rows are honestly not probeable over plain HTTP (no browser in CI).",
  "",
].join("\n");
writeFileSync("suite/capabilities.md", md);

process.exit(gatedFails.length ? 1 : 0);
