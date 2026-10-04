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
  /* clear-site-data: honored by the browser on ANY response, an
     upstream response would wipe the engine origin's own storage -
     the host app's state and every virtual site's partition. An
     isolation bug, not just a leak. */
  "clear-site-data",
  /* NEL/Report-To/Reporting-Endpoints: the browser would send
     network-error reports DIRECTLY to upstream-named real endpoints
     (a #34-class browser-direct escape) with the target infra's
     hostnames in the header, for zero proxied-page value. */
  "report-to",
  "nel",
  "reporting-endpoints",
  /* Names upstream origins allowed to read timing; nothing in the
     engine reads it, free to strip. */
  "timing-allow-origin",
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
  /* Spec shape is `N; url=U` (case-insensitive); some servers pad the
     '=', and a quoted U may itself contain ';', so match the first
     url= however spaced and take the REST of the header as the value.
     ponytail: a url= hidden inside a quoted earlier param defeats
     this; spec-shaped headers never hit that. */
  const m = refresh.match(/url\s*=\s*/i);
  if (!m || m.index === undefined) return;
  let v = refresh.slice(m.index + m[0].length).trim();
  if (v.startsWith('"')) v = v.slice(1).replace(/"$/, "");
  try {
    headers.set("refresh", refresh.slice(0, m.index) + "url=" + encodeDest(new URL(v, dest).href));
  } catch {
    headers.delete("refresh");
  }
}

/* ---- Charset resolution (issue B) -----------------------------------
   A rewritten body is decoded with the upstream charset and served
   re-encoded UTF-8, so the served content-type must declare utf-8.
   Resolution order: the Content-Type header's charset parameter,
   then a BOM, then a prescan of the head bytes (an HTML <meta
   charset> or a CSS leading @charset), then the spec default
   (windows-1252 for HTML per the HTML spec, UTF-8 for CSS without
   @charset). ponytail: the prescan is a latin1 regex, not the full
   HTML prescan algorithm - a UTF-16 page without a BOM whose meta
   only a 16-bit decode would find loses; such pages virtually always
   carry a BOM. */

export function charsetFromHeader(contentType: string): string | null {
  const m = /charset\s*=\s*"?([A-Za-z0-9:_-]+)"?/i.exec(contentType);
  return m ? m[1] : null;
}

const BOMS: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

function latin1(head: Uint8Array, max: number): string {
  let s = "";
  for (let i = 0; i < head.length && i < max; i++) s += String.fromCharCode(head[i]);
  return s;
}

/** The TextDecoder label a rewritable body decodes with. */
export function resolveCharset(contentType: string, head: Uint8Array | null, html: boolean): string {
  const fromHeader = charsetFromHeader(contentType);
  if (fromHeader) return fromHeader;
  if (head && head.length >= 2) {
    for (const [bom, label] of BOMS) {
      if (bom.every((b, i) => head[i] === b)) return label;
    }
  }
  if (head) {
    const s = latin1(head, 1024);
    if (html) {
      const m = /<meta[^>]*charset\s*=\s*["']?\s*([A-Za-z0-9:_-]+)/i.exec(s);
      if (m) return m[1];
    } else {
      const m = /^\s*@charset\s+"([^"]+)"/i.exec(s);
      if (m) return m[1];
    }
  }
  return html ? "windows-1252" : "utf-8";
}

/** A TextDecoder that never throws: a bogus header label (servers
    ship them) degrades to the default decoder instead of failing the
    response. */
export function makeDecoder(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder();
  }
}

/** Decode a complete body with the upstream charset; the fetch spec's
    text() is always UTF-8, which silently mangled every legacy-encoded
    script body. */
export function decodeBody(buf: ArrayBuffer, contentType: string): string {
  return makeDecoder(resolveCharset(contentType, new Uint8Array(buf), false)).decode(buf);
}

/** The served copy of a rewritten body is UTF-8: rewrite the
    content-type's charset (or add one) so the browser decodes what the
    engine actually emitted, never the upstream label. */
export function utf8ContentType(contentType: string): string {
  const ct = contentType.trim();
  if (!ct) return "text/html; charset=utf-8";
  if (/charset\s*=/i.test(ct)) return ct.replace(/charset\s*=\s*[^;]*/i, "charset=utf-8");
  return ct + "; charset=utf-8";
}
