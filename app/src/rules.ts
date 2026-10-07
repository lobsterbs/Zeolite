/* Interception rules engine (Phase 1, 1.1 Oxide). Data-driven
   block / allow / rewrite / modify lists with optional resource-type
   filters, compiled once per SW lifetime. The default /rules.kdl
   ships the ad + tracker host lists migrated from the browser app's
   server-side engine, so client-side mode blocks the same hosts.

   Grammar (KDL v2 subset, parser in kdl.ts):
     block   "doubleclick.net"                  // every type
     allow   "challenges.cloudflare.com"
     block   "ads.example" { types "script" }   // filtered
     rewrite "http://insecure.example/" "https://insecure.example/"
     modify  "news.example" { types "fetch"; header "x-rule" "1" }

   Host matching follows the siteconfig grammar: exact hostname or
   any parent domain. allow beats block (captcha hosts must never be
   stripped). The host app toggles the compiled data via the
   zl:adblock control message and pushes per-site overrides (host,
   adblock, user-agent) via zl:rules; disabled rules are a no-op, the
   data stays loaded. See docs/interception.md. */

import { parseKdl, type KdlNode } from "./kdl";

export type ResourceType =
  | "document"
  | "script"
  | "style"
  | "image"
  | "font"
  | "media"
  | "websocket"
  | "worker"
  | "manifest"
  | "eventsource"
  | "wasm"
  | "fetch"
  | "other";

export interface HostEntry {
  host: string;
  /** Resource-type filter; omitted means all types. */
  types?: ResourceType[];
}

export interface RewriteEntry {
  from: string;
  to: string;
  types?: ResourceType[];
}

export interface ModifyEntry {
  host: string;
  headers: Record<string, string>;
  types?: ResourceType[];
}

export interface RulesData {
  block?: HostEntry[];
  allow?: HostEntry[];
  rewrite?: RewriteEntry[];
  modify?: ModifyEntry[];
}

export interface RuleDecision {
  action: "block" | "allow" | "pass";
  /** Rewritten destination URL, when a rewrite rule matched. */
  url?: string;
  /** Header modifications to merge into the outgoing request. */
  headers?: Record<string, string>;
  /** Matched block/allow host, for diagnostics. */
  matched?: string;
}

interface CompiledHost {
  host: string;
  types: Set<ResourceType> | null;
}

export interface CompiledRules {
  block: CompiledHost[];
  allow: CompiledHost[];
  rewrite: { from: string; to: string; types: Set<ResourceType> | null }[];
  modify: { host: string; headers: Record<string, string>; types: Set<ResourceType> | null }[];
}

function compileHosts(list?: HostEntry[]): CompiledHost[] {
  return (list ?? [])
    .filter((e) => typeof e?.host === "string" && e.host.length > 0)
    .map((e) => ({
      host: e.host.toLowerCase().replace(/^\*\./, ""),
      types: e.types?.length ? new Set(e.types) : null,
    }));
}

/** Compile rule data once; matching later touches only Sets. */
export function compileRules(data: RulesData | null | undefined): CompiledRules {
  return {
    block: compileHosts(data?.block),
    allow: compileHosts(data?.allow),
    rewrite: (data?.rewrite ?? [])
      .filter((r) => r?.from && r?.to)
      .map((r) => ({ from: r.from, to: r.to, types: r.types?.length ? new Set(r.types) : null })),
    modify: (data?.modify ?? [])
      .filter((m) => m?.host && m.headers)
      .map((m) => ({
        host: m.host.toLowerCase(),
        headers: m.headers,
        types: m.types?.length ? new Set(m.types) : null,
      })),
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesHost(entry: CompiledHost, host: string): boolean {
  return host === entry.host || host.endsWith("." + entry.host);
}

function typeOk(types: Set<ResourceType> | null, rtype: ResourceType): boolean {
  return !types || types.has(rtype);
}

let rulesEnabled = true;

/** Host toggle (zl:adblock control message). Resets to enabled on SW
    restart; the host re-sends on boot. */
export function setRulesEnabled(enabled: boolean): void {
  rulesEnabled = enabled;
}

/** Evaluate all lists against one request. Deterministic order: allow
    beats block; rewrite and modify accumulate. */
export function applyRules(r: CompiledRules, url: string, rtype: ResourceType): RuleDecision {
  const dec: RuleDecision = { action: "pass" };
  if (!rulesEnabled) return dec;
  const host = hostOf(url);
  if (!host) return dec;
  for (const e of r.allow) {
    if (matchesHost(e, host) && typeOk(e.types, rtype)) {
      dec.action = "allow";
      dec.matched = e.host;
      break;
    }
  }
  /* A per-site override with adblock false (zl:rules) spares this
     host's requests from the block list; the allow list and the
     rewrite/modify passes are unchanged. */
  if (dec.action !== "allow" && siteOverrideFor(url)?.adblock !== false) {
    for (const e of r.block) {
      if (matchesHost(e, host) && typeOk(e.types, rtype)) {
        dec.action = "block";
        dec.matched = e.host;
        break;
      }
    }
  }
  let u = url;
  for (const e of r.rewrite) {
    if (u.startsWith(e.from) && typeOk(e.types, rtype)) {
      u = e.to + u.slice(e.from.length);
      dec.url = u;
    }
  }
  for (const e of r.modify) {
    if (matchesHost({ host: e.host, types: e.types }, host) && typeOk(e.types, rtype)) {
      dec.headers = { ...(dec.headers ?? {}), ...e.headers };
    }
  }
  return dec;
}

/** Resource-type filter of an entry node: the `types` child node's
    string args; undefined when absent. */
function typesOf(node: KdlNode): ResourceType[] | undefined {
  const t = node.children.find((c) => c.name === "types");
  return t ? t.args.filter((a): a is ResourceType => typeof a === "string") : undefined;
}

/** Parse the rules.kdl grammar into compileRules input. Unknown node
    names are skipped, like the old JSON parser ignored unknown
    fields; a bad file still means "no rules". */
function parseRulesKdl(doc: KdlNode[]): RulesData {
  const data: RulesData = {};
  for (const node of doc) {
    const host = node.args[0];
    if (node.name === "block" || node.name === "allow") {
      if (typeof host !== "string" || host.length === 0) continue;
      const entry: HostEntry = { host, types: typesOf(node) };
      if (node.name === "block") {
        if (!data.block) data.block = [];
        data.block.push(entry);
      } else {
        if (!data.allow) data.allow = [];
        data.allow.push(entry);
      }
    } else if (node.name === "rewrite") {
      const to = node.args[1];
      if (typeof host !== "string" || typeof to !== "string" || !host || !to) continue;
      if (!data.rewrite) data.rewrite = [];
      data.rewrite.push({ from: host, to, types: typesOf(node) });
    } else if (node.name === "modify") {
      if (typeof host !== "string" || host.length === 0) continue;
      const headers: Record<string, string> = {};
      for (const c of node.children) {
        if (c.name !== "header") continue;
        const n = c.args[0];
        const v = c.args[1];
        if (typeof n === "string" && typeof v === "string") headers[n] = v;
      }
      if (!data.modify) data.modify = [];
      data.modify.push({ host, headers, types: typesOf(node) });
    }
  }
  return data;
}

let cached: Promise<CompiledRules> | null = null;

/** Fetch (and memoize for the SW lifetime) /rules.kdl. A missing or
    malformed file means "no rules": the engine must still work. */
export function loadRules(): Promise<CompiledRules> {
  if (!cached) {
    cached = (async () => {
      try {
        const resp = await fetch("/rules.kdl", { cache: "no-cache" });
        if (!resp.ok) return compileRules(null);
        return compileRules(parseRulesKdl(parseKdl(await resp.text())));
      } catch {
        return compileRules(null);
      }
    })();
  }
  return cached;
}

/* ---- Runtime per-site overrides (host app, zl:rules) --------------
   The host app pushes per-site decisions at runtime, beside the
   static /rules.kdl data: a host-scoped adblock override and a
   User-Agent string (plus a default UA for hosts without an
   override). Same host grammar as the static lists: exact hostname
   or any parent domain, longest suffix wins. Ephemeral like the
   zl:adblock toggle - the SW resets on restart and the host re-sends
   on boot. */

export interface SiteOverrideEntry {
  host: string;
  /** false = the block list never matches this host (allow still wins). */
  adblock?: boolean;
  /** Outgoing user-agent for this host; omitted inherits the default. */
  ua?: string | null;
}

let overrides: SiteOverrideEntry[] = [];
let defaultUa: string | null = null;

/** Replace the override set (and the default UA). Returns the stored
    entry count; non-array input means "no overrides", never a crash. */
export function setSiteOverrides(
  list: SiteOverrideEntry[] | null | undefined,
  ua?: unknown,
): number {
  const l = Array.isArray(list) ? list : [];
  overrides = l
    .filter((e) => typeof e?.host === "string" && e.host.length > 0)
    .map((e) => ({
      host: e.host.toLowerCase().replace(/^\*\./, ""),
      adblock: typeof e.adblock === "boolean" ? e.adblock : undefined,
      ua: typeof e.ua === "string" && e.ua.length > 0 ? e.ua : undefined,
    }));
  defaultUa = typeof ua === "string" && ua.length > 0 ? ua : null;
  return overrides.length;
}

/** Longest host-suffix override for a target URL, or null. */
export function siteOverrideFor(url: string): SiteOverrideEntry | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  let best: SiteOverrideEntry | null = null;
  for (const o of overrides) {
    if (host === o.host || host.endsWith("." + o.host)) {
      if (!best || o.host.length > best.host.length) best = o;
    }
  }
  return best;
}

/** Effective outgoing user-agent for a target URL, or null for the
    browser default. A matching override wins over the default UA. */
export function siteUaFor(url: string): string | null {
  return siteOverrideFor(url)?.ua ?? defaultUa;
}

/** Tests only: drop the memoized rules and re-enable. */
export function rulesResetForTests(): void {
  cached = null;
  rulesEnabled = true;
  overrides = [];
  defaultUa = null;
}
