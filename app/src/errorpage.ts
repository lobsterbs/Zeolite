/* Engine-owned navigation error page (issues #3, #31).

   A navigation that fails inside the transport answers with an HTML
   page the engine owns, styled after the host's Material 3 Expressive
   surfaces (inline CSS only: the page loads no fonts, scripts or
   components, so it renders identically on a cold cache). It carries
   the one-line failure category, a details card with the joinable
   diagnostics facts (category, reason, status, trace id, engine
   version), one retry action, and a machine-readable zl-error meta
   payload embedders and DevTools can read. Subresource failures keep
   the honest 502 text/plain body - no UI.

   Issue #32: the page never prints the destination URL. The address
   bar already shows the opaque engine route of the failed navigation;
   printing the plaintext destination on an engine-origin document
   would expose it to any script (or iframe embedding) on that
   origin, which is exactly the leak class #32 closes. For the same
   reason the reason line is URL-redacted before it lands on the page
   or in the meta: a transport error string may quote a hop URL. The
   structured rings (DiagEvent / trace / netLog) keep the unredacted
   truth; the trace id joins the page to them.

   Issue #31: the page is also the answer for engine-side navigation
   strands, not only transport failures. A malformed engine route
   (decode failure, non-http(s) nav marker target), a disabled site
   and a policy block are all navigation-capable outcomes; they land
   here (category "route" / "blocked") with their own reason and
   status, so no in-engine navigation outcome is a silent strand.

   The page is deterministic: same input, byte-identical HTML.

   The no-control case (a browser hits an engine route with no
   controlling worker) cannot be answered by the engine at all: with
   no worker scoped to the route, nothing of the engine runs. The
   embedder serves a documented snippet there; see
   docs/error-pages.md. */

export type ErrorCategory =
  | "dns"
  | "tls"
  | "timeout"
  | "blocked"
  | "stream"
  | "route";

/** Map a transport failure to one honest category from the issue #3
    contract. Unrecognized failures are "stream" (the transport stream
    died) - a cause is never invented. */
export function classifyFailure(reason: string): ErrorCategory {
  const r = reason.toLowerCase();
  if (/dns|getaddrinfo|enotfound|hostnotfound|name or service|resolve/.test(r)) {
    return "dns";
  }
  if (/tls|ssl|certificate|cert|x509|handshake/.test(r)) {
    return "tls";
  }
  if (/timeout|timed out|etimedout|econntimedout/.test(r)) {
    return "timeout";
  }
  if (/blocked|forbidden|403|policy|denied|rejected/.test(r)) {
    return "blocked";
  }
  return "stream";
}

const CATEGORY_TEXT: Record<ErrorCategory, string> = {
  dns: "The site could not be found (DNS).",
  tls: "The secure connection failed (TLS).",
  timeout: "The site took too long to answer.",
  blocked: "The request was blocked by policy.",
  stream: "The connection was interrupted mid-response.",
  route: "The engine route for this page is malformed.",
};

/** Escape a string for safe embedding in HTML text or attribute
    content. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Redact URL-shaped substrings from a reason before it lands on the
    page or in the meta payload (#32: no plaintext destinations on an
    engine-origin document). The ring records keep the unredacted
    string; the trace id joins them. */
function redactUrls(s: string): string {
  return s.replace(/https?:\/\/[^\s"'<>\\]+/g, "[redacted url]");
}

/** Cap a page-visible string: a stack-heavy transport reason must
    not grow the document unboundedly. */
function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

export interface ErrorPageInput {
  /** The engine route path (+ query) the retry action navigates to. */
  route: string;
  category: ErrorCategory;
  engineVersion: string;
  /** Short human-readable cause. URL-redacted before display (#32). */
  reason?: string;
  /** Diag trace id; joins the page into the diag/netLog rings. */
  traceId?: string;
  /** HTTP status the engine answered this navigation with. */
  status?: number;
}

/** The engine error document. Pure and deterministic: same input,
    byte-identical HTML out. */
export function errorPage(input: ErrorPageInput): string {
  const reason = input.reason ? cap(redactUrls(input.reason), 300) : "";
  const meta = JSON.stringify({
    category: input.category,
    version: input.engineVersion,
    route: input.route,
    ...(reason ? { reason } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(typeof input.status === "number" ? { status: input.status } : {}),
  });
  const row = (k: string, v: string, cls?: string): string =>
    `<div class="row"><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ""}>${esc(v)}</dd></div>`;
  let rows = row("Category", input.category);
  if (reason) rows += row("Reason", reason);
  if (typeof input.status === "number") rows += row("Status", String(input.status));
  if (input.traceId) rows += row("Trace ID", input.traceId, "mono");
  rows += row("Engine", "zeolite " + input.engineVersion);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="zl-error" content="${esc(meta)}">
<title>Could not load this page</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 16px/1.5 "Google Sans Flex", "Google Sans Text", system-ui, sans-serif;
  background: #f7f5ff; color: #141218; }
main { width: min(92vw, 36em); margin: 1em; padding: clamp(24px, 5vw, 48px);
  background: #ffffff; border: 1px solid rgba(127,127,140,.25);
  border-radius: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
h1 { font-size: 1.4rem; font-weight: 500; margin: 0 0 .35em; }
p.cat { margin: 0; }
h2 { font-size: .875rem; font-weight: 500; margin: 1.75em 0 .25em;
  text-transform: uppercase; letter-spacing: .08em; color: #4a4458; }
dl { margin: 0; }
.row { display: flex; gap: 16px; padding: 8px 0;
  border-bottom: 1px solid rgba(127,127,140,.12); }
.row:last-child { border-bottom: none; }
dt { flex: 0 0 96px; margin: 0; font-size: .875rem; color: #4a4458; }
dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
dd.mono { font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: .8125rem; }
p.hint { margin: 1.25em 0 0; font-size: .8125rem; color: #4a4458; }
a.retry { display: inline-block; margin-top: 2em; padding: .7em 1.75em;
  border-radius: 999px; background: #6750a4; color: #fff;
  font-size: .875rem; font-weight: 500; text-decoration: none; }
a.retry:focus-visible { outline: 2px solid #6750a4; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  body { background: #141218; color: #f5eff7; }
  main { background: #1d1b20; box-shadow: none; }
  h2, dt, p.hint { color: #cac4d0; }
  a.retry { background: #cfbcff; color: #381e72; }
  a.retry:focus-visible { outline-color: #cfbcff; }
}
</style>
</head>
<body>
<main>
<h1>Could not load this page</h1>
<p class="cat">${esc(CATEGORY_TEXT[input.category])}</p>
<h2>Details</h2>
<dl>
${rows}
</dl>
<p class="hint">Full request logs live in the engine diagnostics rings (the embedder's DevTools network and diagnostics panels); the trace ID joins them.</p>
<a class="retry" href="${esc(input.route)}">Retry</a>
</main>
</body>
</html>
`;
}
