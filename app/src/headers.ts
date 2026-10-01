import { encodeDest } from "./codec";

/* ---- Header surgery ------------------------------------------------
   Extracted from sw.ts so the destination-bearing header policy is
   unit-testable (app/src/__tests__/leak.test.ts); the SW is the only
   caller. */

export const HOSTILE = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "set-cookie",
  "set-cookie2",
  /* The transport delivers decoded bodies: a preserved upstream
     content-encoding would make every fetch() consumer decode
     plaintext a second time (corrupted bytes), and the rewritten
     body never matches the upstream length. */
  "content-encoding",
  "content-length",
  /* Destination-bearing informational headers (#32 follow-up): each
     can name the real target origin in plaintext on a proxied
     response. Link (preload hints), Content-Location (alternate
     representation locator) and X-Original-URL (service-injected
     destination marker) are informational; stripping them is
     correctness-neutral.
     ponytail: re-encoding Link preload targets as engine routes is
     the upgrade path if a site measurably regresses; none known. */
  "link",
  "content-location",
  "x-original-url",
];

export function stripHostile(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOSTILE.includes(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/** Refresh is functional (delayed navigation), so its url= is mapped
    to an engine route against the response destination instead of
    stripped. A same-page refresh (no url=) carries no destination and
    passes untouched; an unresolvable url= fails closed (header
    dropped, never a plaintext target handed to the browser). */
export function mapRefreshHeader(headers: Headers, dest: string): void {
  const refresh = headers.get("refresh");
  if (!refresh) return;
  const i = refresh.toLowerCase().indexOf("url=");
  if (i < 0) return;
  let v = refresh.slice(i + 4).trim();
  if (v.startsWith('"')) v = v.slice(1).replace(/"$/, "");
  try {
    headers.set("refresh", refresh.slice(0, i + 4) + encodeDest(new URL(v, dest).href));
  } catch {
    headers.delete("refresh");
  }
}
