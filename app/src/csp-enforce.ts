/* #527: engine-side CSP source-list enforcement (opt-in, cspTranslation).

   The browser-visible translation (csp-translation.ts) can only hand the
   proxied document a deny-only policy: serving an upstream source list to
   the browser would either block every engine route (the hosts never
   match) or grant the shared engine origin (weakening every virtual site
   that lives on it). Origin/path source lists and 'self' therefore have
   NO safe browser-side translation.

   This module enforces them at the engine boundary instead, the same
   seam #531 uses for SRI: the fetch handler knows the DECODED upstream
   URL of every route and the document's own virtual origin, so the
   upstream policy is matched against exactly the truth the direct
   browser matches it against. 'self' is the document's virtual origin
   - never the engine origin - so no shared-origin grant is possible.

   Guarantees:
   - Never broadens: a blocked load answers a network error, the same
     shape a direct CSP violation produces.
   - Never falsely blocks: a directive whose list carries nonce/hash/
     strict-dynamic tokens stays unenforced (the element's nonce cannot
     be verified at the fetch seam); a source expression the parser
     does not fully understand degrades the whole directive to
     unenforced. Every degrade is a false allow, never a false block.
   - Memory-only per-client registry (like #531/#33): a worker restart
     or a page-cache document serve (the stored view is hostile-header
     stripped) leaves the client unenforced. A navigation clears the
     client's plan before the new document can install one, so no
     document ever inherits a stale policy.

   Matching follows CSP3 host-source semantics: a plain host matches
   exactly that host; *.host matches subdomains only; an absent port
   matches only the scheme's default port; a trailing "/" makes the
   path a prefix, otherwise the path must match exactly; query and
   fragment never participate; an absent scheme matches the page's own
   scheme. ponytail: the path compare is raw (no percent-decoding) and
   IPv6 host literals stay unverifiable; upgrade if a live policy
   needs them. */

const MAX_POLICY_BYTES = 8192;
const MAX_DIRECTIVES = 64;
const MAX_SOURCES = 64;
const CLIENTS_CAP = 256;

/* The fetch directives the engine can gate. frame-src/worker-src/
   object-src belong to the browser-enforced deny-only subset (their
   request classes are navigations/workers/embeds, not subresource
   fetches through this seam). */
const FETCH_DIRECTIVES = new Set([
  "script-src", "style-src", "img-src", "font-src", "media-src", "connect-src",
]);

const DEST_DIRECTIVE: Record<string, string> = {
  script: "script-src",
  style: "style-src",
  image: "img-src",
  font: "font-src",
  media: "media-src",
  audio: "media-src",
  video: "media-src",
  track: "media-src",
  empty: "connect-src",
};

export interface CspSource {
  k: "self" | "any" | "scheme" | "host";
  scheme?: string;
  host?: string;
  wildcard?: boolean;
  port?: string;
  path?: string;
}

export interface CspEnginePlan {
  selfOrigin: string;
  pageScheme: string;
  /** Fully evaluable directives, in policy order. */
  enforced: string[];
  /** Directives seen but not enforceable (nonce/hash/strict-dynamic...). */
  unsupported: string[];
  sources: Map<string, CspSource[]>;
  defaultSrc: CspSource[] | null;
}

export function emptyCspPlan(selfOrigin: string, pageScheme: string): CspEnginePlan {
  return {
    selfOrigin,
    pageScheme,
    enforced: [],
    unsupported: [],
    sources: new Map(),
    defaultSrc: null,
  };
}

/* Behavioral keywords: they govern inline/eval/reporting behavior, not
   fetch destinations, so the fetch-side gate simply does not see them
   (inline and eval are not requests through this seam). */
const IGNORED_KEYWORDS = new Set([
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  "'unsafe-hashes'",
  "'report-sample'",
]);

/* Schemes whose fetches can never ride an engine route (the engine
   only decodes http/https destinations): ignoring them is a false
   allow, and they cannot cause a false block. */
const NON_NETWORK_SCHEMES = new Set([
  "data", "blob", "filesystem", "mediastream", "ws", "wss",
]);

type TokenVerdict =
  | { ok: true; src?: CspSource }
  | { ok: false; ignore: true }
  | { ok: false; unverifiable: true };

function parseToken(tok: string): TokenVerdict {
  if (IGNORED_KEYWORDS.has(tok)) return { ok: false, ignore: true };
  if (tok === "'self'") return { ok: true, src: { k: "self" } };
  if (tok === "'strict-dynamic'" || tok === "'allow'" || tok.startsWith("'nonce-"))
    return { ok: false, unverifiable: true };
  if (tok === "*") return { ok: true, src: { k: "any" } };
  /* Hash sources are bare "<alg>-<base64>" tokens with the three
     specified algorithms; anything else in that shape is more likely
     a single-label host than a hash, so only these gate. */
  if (!tok.startsWith("'") && /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(tok))
    return { ok: false, unverifiable: true };
  /* Scheme-only source. */
  if (/^[a-z][a-z0-9+.-]*:$/i.test(tok)) {
    const scheme = tok.slice(0, -1).toLowerCase();
    if (scheme === "http" || scheme === "https")
      return { ok: true, src: { k: "scheme", scheme } };
    return { ok: false, ignore: true };
  }
  /* Host source: [scheme://]host[:port][/path]. */
  const m = tok.match(/^(?:([a-z][a-z0-9+.-]*)?:\/\/)?([^/:]+)(?::(\*|\d+))?(\/.*)?$/i);
  if (!m) return { ok: false, unverifiable: true };
  const [, scheme, host, port, path] = m;
  if (scheme !== undefined) {
    const s = scheme.toLowerCase();
    if (s !== "http" && s !== "https") return { ok: false, ignore: true };
  }
  if (host === "*") return { ok: true, src: { k: "any" } };
  let wildcard = false;
  let h = host.toLowerCase();
  if (h.startsWith("*.")) {
    wildcard = true;
    h = h.slice(2);
  }
  /* IPv6 literals and anything unusual stay unverifiable. */
  if (!/^[a-z0-9.-]+$/.test(h) || h.length === 0) return { ok: false, unverifiable: true };
  if (h.includes("*")) return { ok: false, unverifiable: true };
  return {
    ok: true,
    src: {
      k: "host",
      scheme: scheme ? scheme.toLowerCase() : undefined,
      host: h,
      wildcard,
      port,
      path,
    },
  };
}

function parseSourceList(tokens: string[]): { sources: CspSource[] } | { unverifiable: true } {
  const out: CspSource[] = [];
  for (const tok of tokens) {
    const v = parseToken(tok);
    if (!v.ok) {
      if ("ignore" in v) continue;
      return { unverifiable: true };
    }
    if (v.src) out.push(v.src);
  }
  return { sources: out };
}

/** Plan the engine-side (fetch-seam) enforcement of an upstream CSP
    for the document at docUrl. Invalid syntax, duplicates, commas and
    oversize policies yield an empty plan (unenforced), mirroring the
    conservative planner in csp-translation.ts. */
export function planEngineCsp(raw: string, docUrl: string): CspEnginePlan {
  let selfOrigin = "";
  let pageScheme = "https:";
  try {
    const u = new URL(docUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return emptyCspPlan("", "https:");
    selfOrigin = u.origin;
    pageScheme = u.protocol;
  } catch {
    return emptyCspPlan("", "https:");
  }
  const plan = emptyCspPlan(selfOrigin, pageScheme);
  if (!raw.trim() || /[\x00-\x1f\x7f,]/.test(raw) || raw.length > MAX_POLICY_BYTES)
    return plan;
  const parts = raw.split(";");
  if (parts.length > MAX_DIRECTIVES + 1) return plan;
  const seen = new Set<string>();
  for (const part of parts) {
    const directive = part.trim();
    if (!directive) continue;
    const tokens = directive.split(/\s+/);
    const name = tokens[0].toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return emptyCspPlan(selfOrigin, pageScheme);
    if (seen.has(name)) return emptyCspPlan(selfOrigin, pageScheme);
    seen.add(name);
    /* A directive with no source tokens is invalid: the browser ignores
      it, so the engine-side mirror stays unenforced too. */
    if (tokens.length < 2) continue;
    if (tokens.length - 1 > MAX_SOURCES) continue;
    if (!FETCH_DIRECTIVES.has(name) && name !== "default-src") continue;
    const list = parseSourceList(tokens.slice(1));
    if ("unverifiable" in list) {
      plan.unsupported.push(name);
      continue;
    }
    if (name === "default-src") {
      plan.defaultSrc = list.sources;
      continue;
    }
    plan.sources.set(name, list.sources);
    plan.enforced.push(name);
  }
  return plan;
}

/** CSP3 host-source matching against the decoded upstream URL. */
export function sourceMatches(s: CspSource, u: URL, plan: CspEnginePlan): boolean {
  if (s.k === "self") return u.origin === plan.selfOrigin;
  if (s.k === "any") return u.protocol === "http:" || u.protocol === "https:";
  if (s.k === "scheme") return u.protocol === s.scheme + ":";
  /* host */
  if (s.scheme) {
    if (u.protocol !== s.scheme + ":") return false;
  } else if (u.protocol !== plan.pageScheme) {
    return false;
  }
  const uh = u.hostname.toLowerCase();
  const hostOk = s.wildcard
    ? uh.endsWith("." + s.host!)
    : uh === s.host!;
  if (!hostOk) return false;
  if (s.port === undefined) {
    /* An absent port matches only the scheme's default port. */
    if (u.port !== "") return false;
  } else if (s.port !== "*") {
    if (u.port !== s.port) return false;
  }
  if (s.path !== undefined) {
    if (s.path.endsWith("/")) {
      if (!u.pathname.startsWith(s.path)) return false;
    } else if (u.pathname !== s.path) return false;
  }
  return true;
}

/* ---- per-client plan registry (memory-only, like #531/#33) ---- */

export interface CspRegistry {
  clients: Map<string, CspEnginePlan>;
}

export function newCspRegistry(): CspRegistry {
  return { clients: new Map() };
}

export function cspSetClient(reg: CspRegistry, clientId: string, plan: CspEnginePlan): void {
  if (!clientId) return;
  if (reg.clients.size >= CLIENTS_CAP && !reg.clients.has(clientId)) {
    const oldest = reg.clients.keys().next().value;
    if (oldest !== undefined) reg.clients.delete(oldest);
  }
  reg.clients.set(clientId, plan);
}

/** A navigation replaced the client's document: the old plan must never
    gate the next document's subresources. */
export function cspClearClient(reg: CspRegistry, clientId: string | undefined): void {
  if (clientId) reg.clients.delete(clientId);
}

export interface CspGateDecision {
  blocked: boolean;
  /** The directive that decided the request, for the bounded diagnostic. */
  directive?: string;
}

/** Decide one subresource request against the requesting client's
    document policy. Unenforced classes (no plan, no matching directive,
    unverifiable lists, non-network destinations) always allow - the
    false-allow direction. */
export function cspGate(
  reg: CspRegistry,
  clientId: string | undefined,
  dest: string,
  absUrl: string,
): CspGateDecision {
  const directive = DEST_DIRECTIVE[dest];
  if (!directive || !clientId) return { blocked: false };
  const plan = reg.clients.get(clientId);
  if (!plan || (!plan.sources.size && !plan.defaultSrc)) return { blocked: false };
  let u: URL;
  try {
    u = new URL(absUrl);
  } catch {
    return { blocked: false };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { blocked: false };
  const explicit = plan.sources.get(directive);
  if (explicit) {
    for (const s of explicit) if (sourceMatches(s, u, plan)) return { blocked: false, directive };
    return { blocked: true, directive };
  }
  if (plan.defaultSrc) {
    for (const s of plan.defaultSrc) if (sourceMatches(s, u, plan)) return { blocked: false, directive: "default-src" };
    return { blocked: true, directive: "default-src" };
  }
  return { blocked: false };
}

/** The x-zl-csp marker segment for the engine-side plan. Values are
    engine-generated whitelisted directive names only - no upstream
    source text ever enters the marker. */
export function engineCspMarker(plan: CspEnginePlan): string | null {
  const segs: string[] = [];
  /* default-src surfaces only when the engine really enforces it: a
     parsed fallback list gates every directive the policy does not
     name, so a default-src-only policy must not report "nothing
     enforced" while the seam blocks. */
  const enforced = [...plan.enforced, ...(plan.defaultSrc ? ["default-src"] : [])];
  if (enforced.length) segs.push("engine " + enforced.join(","));
  if (plan.unsupported.length) segs.push("engine-unsupported " + plan.unsupported.join(","));
  return segs.length ? segs.join("; ") : null;
}
