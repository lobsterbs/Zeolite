/* Engine-owned navigation error page (issue #3).

   A navigation that fails inside the transport answers with a minimal
   HTML page the engine owns: the target URL, a one-line failure
   category, one retry action, prefers-color-scheme aware, plus a
   machine-readable zl-error meta payload embedders and DevTools can
   read. No stacks, no header dumps, no secrets: the structured rings
   (DiagEvent / trace / netLog) stay the real diagnostics channel, and
   the page carries only what a user needs to act on. Subresource
   failures keep the honest 502 text/plain body - no UI.

   The no-control case (a browser hits an engine route with no
   controlling worker) cannot be answered by the engine at all: with
   no worker scoped to the route, nothing of the engine runs. The
   embedder serves a documented snippet there; see docs/error-pages.md. */

export type ErrorCategory = "dns" | "tls" | "timeout" | "blocked" | "stream";

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
};

/** Escape a string for safe embedding in HTML text or attribute
    content. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export interface ErrorPageInput {
  /** The engine route path (+ query) the retry action navigates to. */
  route: string;
  /** The decoded destination URL, shown to the user. */
  target: string;
  category: ErrorCategory;
  engineVersion: string;
}

/** The minimal engine error document. Pure and deterministic: same
    input, byte-identical HTML out. */
export function errorPage(input: ErrorPageInput): string {
  const meta = JSON.stringify({
    target: input.target,
    category: input.category,
    version: input.engineVersion,
  });
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
  font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 34em; padding: 1.5em; }
h1 { font-size: 1.1em; margin: 0 0 .5em; }
code { overflow-wrap: anywhere; }
a { display: inline-block; margin-top: 1em; padding: .5em 1.25em;
  border-radius: .5em; background: #0b57d0; color: #fff;
  text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>Could not load this page</h1>
<p><code>${esc(input.target)}</code></p>
<p>${esc(CATEGORY_TEXT[input.category])}</p>
<p><a href="${esc(input.route)}">Retry</a></p>
</main>
</body>
</html>
`;
}
