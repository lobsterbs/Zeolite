/* Engine-owned navigation error page (issues #3, #31, #129).

   A failed in-transport navigation answers with an HTML page the
   engine owns. The #129 redesign (operator request): the Zeolite
   ASCII logo centered, the issue facts listed under it (reason,
   category, status, trace id, engine version), and one try-again
   button - a real button in a GET form, so no scripts are needed
   and it works on a cold cache. Plain system type, no cards, no
   chrome, no accent color. Inline CSS only. Subresource failures
   keep the honest 502 text/plain body - no UI.

   #32: the page never prints the destination URL (the address bar
   already shows the opaque route; plaintext on an engine-origin
   document would leak it to any script there). Reason lines are
   URL-redacted for the same cause; the structured rings (diag /
   trace / netLog) keep the unredacted truth, joined by trace id.

   #31: engine-side navigation strands land here too - malformed
   route, disabled site, policy block (category "route"/"blocked").
   The page is deterministic: same input, byte-identical HTML.

   The no-control case (engine route with no controlling worker)
   cannot be answered by the engine: the embedder serves a
   documented snippet (docs/error-pages.md). */

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

/* The Zeolite logo (operator-supplied art, #129). Backslashes are
   literal, so this stays a raw string. */
const LOGO = String.raw` _____              ___ __     
/__  /  ___  ____  / (_) /____ 
  / /  / _ \/ __ \/ / / __/ _ \
 / /__/  __/ /_/ / / / /_/  __/
/____/\___/\____/_/_/\__/\___/ `;

/** Escape a string for safe embedding in HTML text or attribute
    content. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;",
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
  const row = (k: string, v: string): string =>
    `
<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
  let rows = "";
  if (reason) rows += row("Reason", reason);
  rows += row("Category", input.category);
  if (typeof input.status === "number") rows += row("Status", String(input.status));
  if (input.traceId) rows += row("Trace ID", input.traceId);
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
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 15px/1.6 system-ui, sans-serif; background: #fff; color: #1c1c1e; }
main { max-width: 32em; padding: 1.5em; text-align: center; }
pre { display: inline-block; text-align: left; max-width: 100%;
  font: 13px/1.15 ui-monospace, Menlo, Consolas, monospace;
  color: #6b6b70; margin: 0 0 1.5em; overflow-x: auto; }
h1 { font-size: 1.0625rem; font-weight: 600; margin: 0 0 .4em; }
p { margin: 0 0 1.5em; color: #6b6b70; }
dl { font: .8125rem/1.8 ui-monospace, Menlo, Consolas, monospace;
  color: #6b6b70; margin: 0 0 1.75em; }
dl > div { display: flex; gap: 1.25em; text-align: left; }
dt { margin: 0; flex: none; }
dd { margin: 0; overflow-wrap: anywhere; }
button { font: inherit; padding: .45em 1.6em; background: none;
  color: inherit; border: 1px solid currentColor; border-radius: 6px;
  cursor: pointer; }
button:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  body { background: #0f0f10; color: #e8e8ea; }
  pre, p, dl { color: #9b9ba0; }
}
</style>
</head>
<body>
<main>
<pre>${esc(LOGO)}</pre>
<h1>Could not load this page</h1>
<p>${esc(CATEGORY_TEXT[input.category])}</p>
<dl>${rows}
</dl>
<form method="get" action="${esc(input.route)}"><button type="submit">Try again</button></form>
</main>
</body>
</html>
`;
}
