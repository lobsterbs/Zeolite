/* #531: engine-side Subresource Integrity verification.

   Issue #77 stripped integrity attributes so rewritten subresources
   load at all: the browser hashes the bytes it receives, the engine
   serves transformed bytes, so the upstream hash can never match and
   the load dies silently. That preserved compatibility but discarded
   the site's integrity guarantee entirely.

   This module restores the guarantee at the engine boundary instead
   of the browser boundary. The document scan below collects the
   integrity metadata the HTML rewriter drops (script src and
   stylesheet href), the fetch handler verifies the RAW UPSTREAM
   bytes against that metadata before any transformed version is
   served, and a mismatch is refused the same way the direct browser
   refuses it. The browser-facing attribute stays dropped: the served
   bytes are transformed, so the upstream hash must never be
   re-attached to them, and a hash of the transformed body cannot
   ride an HTML document that was already served. The decision is
   visible on the served response as x-zl-sri: verified | blocked |
   skipped:<reason>.

   Scope choices, honestly:
   - Verification is engine-side only; Chromium still cannot verify
     transformed bytes, and the direct browser oracle keeps enforcing
     its own native SRI on unproxied loads.
   - The registry is memory-only and per-client (the SW client id of
     the owning document), like the #33 virtual contexts: a worker
     restart loses the expectations and later loads fall back to the
     unverified compatibility serve. No hashes are persisted.
   - Unsupported algorithms (sha1, md5, whatever lands later) and
     malformed metadata fall back to the compatibility serve with a
     bounded diagnostic reason; only supported candidates gate.
   - The scan reads the first SRI_SCAN_TEXT_MAX of decoded upstream
   - document text and keeps at most SRI_ENTRIES_CAP entries per
     client, so a hostile document cannot grow the registry. */

/* The hash algorithms the engine can verify with WebCrypto, mapped
   to their SubtleCrypto names. Anything else in the metadata is an
   unsupported candidate: it never gates and never blocks alone. */
const SRI_ALGS: Record<string, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

/** Bodies above this size skip verification (bounded diagnostic, safe
    compatibility fallback) instead of buffering unbounded streams. */
export const SRI_VERIFY_BYTE_CAP = 4 * 1024 * 1024;

/** Document scan bounds. */
export const SRI_SCAN_TEXT_MAX = 256 * 1024;
export const SRI_ENTRIES_CAP = 128;
export const SRI_CLIENTS_CAP = 256;

/* ---- base64 (hand-rolled: no btoa assumption outside the SW) ---- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

/* ---- integrity metadata parsing ---- */

export interface SriCandidates {
  /** Supported candidates in metadata order. */
  supported: Array<{ alg: string; b64: string }>;
  /** At least one token used an algorithm the engine cannot verify. */
  unsupported: boolean;
  /** At least one token did not parse as hash metadata at all. */
  malformed: boolean;
}

/** Parse an integrity attribute value: whitespace-separated
    "<alg>-<base64>" tokens (#531). Unknown algorithms are flagged,
    not fatal: a multi-candidate list with one sha256 and one
    future-hash must still gate on the sha256. */
export function parseSri(value: string): SriCandidates {
  const out: SriCandidates = { supported: [], unsupported: false, malformed: false };
  for (const tok of String(value ?? "").split(/\s+/)) {
    if (!tok) continue;
    const dash = tok.indexOf("-");
    if (dash <= 0) {
      out.malformed = true;
      continue;
    }
    const alg = tok.slice(0, dash).toLowerCase();
    const b64 = tok.slice(dash + 1);
    if (!b64 || /[^A-Za-z0-9+/=]/.test(b64)) {
      out.malformed = true;
      continue;
    }
    if (SRI_ALGS[alg]) out.supported.push({ alg, b64 });
    else out.unsupported = true;
  }
  return out;
}

export type SriDecision =
  | "verified"
  | "blocked"
  | "skipped:body-too-large"
  | "skipped:unsupported-algorithm"
  | "skipped:malformed"
  | "skipped:no-candidates";

/** Verify raw upstream bytes against the page-recorded integrity
    metadata. The hash is always over the bytes as received from
    upstream, never over transformed output. Never throws: any
    internal failure degrades to the compatibility serve with a
    bounded reason. */
export async function sriVerifyBytes(raw: ArrayBuffer, value: string, tooLarge: boolean): Promise<SriDecision> {
  if (tooLarge) return "skipped:body-too-large";
  const c = parseSri(value);
  if (c.malformed) return "skipped:malformed";
  if (c.supported.length === 0) {
    return c.unsupported ? "skipped:unsupported-algorithm" : "skipped:no-candidates";
  }
  const byAlg = new Map<string, Uint8Array>();
  try {
    for (const cand of c.supported) {
      if (byAlg.has(cand.alg)) continue;
      const d = await crypto.subtle.digest(SRI_ALGS[cand.alg], raw);
      byAlg.set(cand.alg, new Uint8Array(d));
    }
  } catch {
    /* WebCrypto unavailable or the buffer detached: the safe
       fallback is the unverified compatibility serve. */
    return "skipped:malformed";
  }
  for (const cand of c.supported) {
    if (bytesToB64(byAlg.get(cand.alg)!) === cand.b64) return "verified";
  }
  return "blocked";
}

/* ---- HTML entity decode (attribute values are entity-encoded in
   source; the browser hands the DOM decoded text, so the scan must
   decode before resolving or the recorded URL never matches the
   request the page actually issues - issue #24 class) ---- */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

export function decodeEntities(v: string): string {
  if (v.indexOf("&") === -1) return v;
  return v.replace(/&(#x?[0-9a-f]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    const name = NAMED[ent];
    if (name !== undefined) return name;
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    if (ent.startsWith("#") && /^#[0-9]+$/.test(ent)) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    /* Unknown or malformed entity: keep the source text. */
    return m;
  });
}

/* ---- incremental document scanner ---- */

export interface SriScanner {
  feed(text: string): void;
}

const TAG_HOLD_MAX = 64 * 1024;

/** Attribute extraction from one opening tag's source text. Values
    ride single or double quotes or bare; unquoted values end at the
    next whitespace or the tag end. Returns null for unquoted values
    containing characters that make the parse ambiguous - the safe
    skip, never a wrong URL. */
function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i");
  const m = tag.match(re);
  if (!m) return null;
  if (m[2] !== undefined) return m[2];
  if (m[3] !== undefined) return m[3];
  if (m[4] !== undefined && /^[^\s"'<>\x00]*$/.test(m[4])) return m[4];
  return null;
}

/** Incremental scan of a served document's decoded upstream text.
    Collects (absolute URL, integrity) pairs from <script src> and
    <link rel=stylesheet href> tags whose integrity attribute the
    rewriter dropped. Chunk-boundary safe: an opening tag split
    across chunks is held until its '>' arrives or TAG_HOLD_MAX
    gives up on it. Pure orchestration over the note callback; never
    throws. */
export function sriScanner(base: string, note: (abs: string, integrity: string) => void): SriScanner {
  let pending = "";
  let fed = 0;
  let pairs = 0;
  let done = false;
  const process = (tag: string): void => {
    if (pairs >= SRI_ENTRIES_CAP) {
      done = true;
      return;
    }
    /* Cheap reject first: the common tag carries no integrity. */
    if (!/\bintegrity\b/i.test(tag)) return;
    const m = tag.match(/^<\s*(script|link)\b/i);
    if (!m) return;
    const kind = m[1].toLowerCase();
    const integrity = attrOf(tag, "integrity");
    if (!integrity) return;
    if (kind === "script") {
      const src = attrOf(tag, "src");
      if (!src) return; /* inline script: no subresource */
      const abs = resolveUrl(src, base);
      if (!abs) return;
      note(abs, integrity);
      pairs += 1;
      return;
    }
    const rel = (attrOf(tag, "rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).indexOf("stylesheet") === -1) return;
    const href = attrOf(tag, "href");
    if (!href) return;
    const abs = resolveUrl(href, base);
    if (!abs) return;
    note(abs, integrity);
    pairs += 1;
  };
  const resolveUrl = (v: string, b: string): string | null => {
    try {
      const u = new URL(decodeEntities(v), b);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.href;
    } catch {
      return null;
    }
  };
  return {
    feed(text: string): void {
      if (done) return;
      pending += text;
      fed += text.length;
      for (;;) {
        const lt = pending.indexOf("<");
        if (lt === -1) {
          pending = "";
          break;
        }
        const gt = pending.indexOf(">", lt);
        if (gt === -1) {
          /* No tag end yet: hold the tail, but bound the hold so a
             document with an unterminated tag cannot grow memory. */
          pending = pending.slice(lt);
          if (pending.length > TAG_HOLD_MAX) pending = "";
          break;
        }
        process(pending.slice(lt, gt + 1));
        pending = pending.slice(gt + 1);
        if (done) {
          pending = "";
          break;
        }
      }
      if (fed >= SRI_SCAN_TEXT_MAX) done = true;
    },
  };
}

/* ---- per-client expectation registry (memory-only, like #33 vctx) ---- */

export interface SriRegistry {
  clients: Map<string, Map<string, string>>;
}

export function newSriRegistry(): SriRegistry {
  return { clients: new Map() };
}

/** Record one expectation for a client's document. Insertion-order
    cap per client; the registry itself is capped by dropping the
    oldest client (client ids are never reused, so a dropped entry
    only degrades to the unverified fallback). */
export function sriNote(reg: SriRegistry, clientId: string, abs: string, integrity: string): void {
  let m = reg.clients.get(clientId);
  if (!m) {
    if (reg.clients.size >= SRI_CLIENTS_CAP) {
      const oldest = reg.clients.keys().next().value;
      if (oldest !== undefined) reg.clients.delete(oldest);
    }
    m = new Map();
    reg.clients.set(clientId, m);
  }
  if (m.size >= SRI_ENTRIES_CAP && !m.has(abs)) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(abs, integrity);
}

/** The recorded integrity metadata for a client's subresource, or
    undefined (the request serves unverified, exactly the pre-#531
    behavior). */
export function sriExpectation(reg: SriRegistry, clientId: string | undefined, abs: string): string | undefined {
  if (!clientId) return undefined;
  return reg.clients.get(clientId)?.get(abs);
}

/** A client's document was replaced (navigation): its old document's
    expectations must never verify the next document's subresources
    against a stale page's metadata. */
export function sriClearClient(reg: SriRegistry, clientId: string | undefined): void {
  if (clientId) reg.clients.delete(clientId);
}

/* ---- served responses ---- */

/** The refusal served when upstream bytes fail verification: a
    short, honest, no-store body typed for the destination, so the
    load fails the way a direct browser's SRI refusal fails it. */
export function sriBlockedResponse(dest: string, status: number): Response {
  const kind = dest === "style" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  return new Response(
    "/* zeolite: upstream subresource integrity verification failed (x-zl-sri: blocked) */",
    {
      status: status >= 500 ? status : 500,
      headers: {
        "content-type": kind,
        "cache-control": "no-store",
        "x-zl-sri": "blocked",
      },
    },
  );
}
