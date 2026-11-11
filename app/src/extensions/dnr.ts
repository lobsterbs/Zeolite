/* Zeolite extension subsystem: declarativeNetRequest (#521, slice 1).

   Declarative request interception for extensions, evaluated inside the
   engine's fetch pipeline BEFORE webRequest listeners run (Chrome's
   documented ordering: webRequest observers see DNR-modified headers).

   Slice 1 scope, honestly cut:
   - Actions: block, allow, modifyHeaders (request + response headers)
     and, since slice 2, redirect: the engine re-enters its own pipeline
     with the redirect target as the new proxied destination, so the
     redirect never navigates natively and cannot leak the tunnel.
     upgradeScheme (slice 3) rides the slice-2 redirect seam: the
     upgraded target (http -> https, ws -> wss, same host) re-enters
     the engine pipeline, so no synthetic native navigation and no
     tunnel leak. allowAllRequests (slice 3) arms a bounded,
     TTL-scoped frame bypass keyed on the document origin the engine
     facts carry (the initiator origin for requests generated from
     the matched document; Chrome's true frame-subtree identity is
     unavailable), silencing the OWNING extension's rules on those
     requests; other extensions keep their verdicts.
   - Rules: session (in-memory), dynamic (persisted per extension to
     IndexedDB, #594's alarms pattern) and static rulesets (package files
     named by the manifest's declarative_net_request.rule_resources,
     loaded lazily; invalid static rules are silently ignored, exactly as
     Firefox documents).
   - Resource types: the engine reports webRequest types via wrType();
     fetch and XHR surface as "xmlhttprequest" there (sec-fetch-dest
     "empty"), so rules typed "xmlhttprequest" match a tunnel fetch as
     they would in a real browser; truly unknown destinations report
     "other".
   - Quota constants are engine-defined approximations of the documented
     Chrome values (MDN fixes no cross-browser numbers): dynamic+session
     combined cap 5000, guaranteed minimum static rules 5000, max 100
     static rulesets, max 50 enabled static rulesets.

   Matching model (per MDN, recorded as the module's ground truth):
   - Within one extension, highest priority wins; at equal priority the
     action class order is allow > allowAllRequests > block >
     upgradeScheme > redirect > modifyHeaders; at equal priority AND
     equal action, session > dynamic > static (Firefox tie-break).
   - Across extensions, block beats allow and redirect alike, so the
     engine-level verdict is block-or-nothing (allow only carves
     exceptions out of the same extension's own lower-priority-class
     block). A redirect survives only when no extension blocks, and the
     first extension in provider order whose best rule redirects wins.
   - modifyHeaders from an extension applies only when that extension's
     best matching rule is a modifyHeaders one and its host permissions
     cover the request URL (and, for sub_frame requests, the initiator
     origin). An allow from another extension does not suppress it.
   - With the "declarativeNetRequestWithHostAccess" permission every
     action (block and allow included) additionally requires a host
     permission on the request URL.

   The permission view is injected through a provider (#282's live-view
   pattern generalized): control.ts wires it over the manager singleton,
   so matching reads live enabled state, host permissions and declared
   static rulesets on every request. No provider, no rules apply -
   honest degradation, never a thrown call in the fetch path. */

import type { ExtensionId } from "./types";
import { openDb, idbGet, idbGetAllKeys, idbPut, idbDelete, STORE_DNR, STORE_FILES } from "./idb";
import { hostPatternsMatch } from "./permissions";

/* ---- quotas (engine-defined, documented) ---- */

export const MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES = 5000;
export const GUARANTEED_MINIMUM_STATIC_RULES = 5000;
export const MAX_NUMBER_OF_STATIC_RULESETS = 100;
export const MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50;

/* ---- vocabulary ---- */

/* Firefox resource-type vocabulary for rule conditions. The engine maps
   a request destination onto one of these via wrType(); a rule typed
   with something the engine cannot distinguish reports "other" and
   only matches rules typed "other", honestly. */
const RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "imageset",
  "font", "object", "xmlhttprequest", "ping", "csp_report", "media",
  "websocket", "webtransport", "webbundle", "other",
]);

/* Same-extension action precedence at equal priority, lower wins first
   (allow carves exceptions out of the extension's own blocks). */
const ACTION_CLASS: Record<string, number> = {
  allow: 0,
  allowAllRequests: 1,
  block: 2,
  upgradeScheme: 3,
  redirect: 4,
  modifyHeaders: 5,
};

/* ---- shapes ---- */

export interface DnrModifyHeaderOp {
  header: string;
  operation: "set" | "remove" | "append";
  value?: string;
}

/** What the fetch pipeline reports per request: the webRequest type
    vocabulary plus the initiator origin when known. */
export interface DnrRequestFacts {
  url: string;
  method: string;
  type: string;
  initiator?: string;
}

/** One static ruleset declared by a manifest. */
export interface DnrRulesetSpec {
  id: string;
  path: string;
  enabled: boolean;
}

/** The live per-extension view the provider hands the registry. */
export interface DnrExtView {
  id: ExtensionId;
  hosts: string[];
  withHostAccess: boolean;
  enabled: boolean;
  staticRulesets: DnrRulesetSpec[];
}

/* The engine-visible verdict for one request: no match, a block, or a
   redirect to an absolute http(s) destination (slice 2: the redirect
   re-enters the engine pipeline, never a native navigation). */
export type DnrVerdict = { kind: "none" } | { kind: "block" } | { kind: "redirect"; url: string };

export type DnrPermProvider = () => DnrExtView[];

/* Where a matched rule lives: the registry collapses the static
   cache across a package's enabled rulesets, so static matches
   also carry the concrete ruleset id on the rule itself. */
type DnrMatchSource = "session" | "dynamic" | "static";

/* One recorded engine-visible DNR match: the payload of
   getMatchedRules and onRuleMatchedDebug (#521). Chrome's tabId
   and minMatchId filters are not provided: the engine request
   facts carry no tab id. */
export interface DnrMatchedRule {
  extensionId: string;
  ruleId: number;
  rulesetId: string;
  source: DnrMatchSource;
  url: string;
  method: string;
  type: string;
  kind: "block" | "redirect";
  redirectUrl?: string;
  timestamp: number;
}

/* Bounded introspection log: enough for a debug session, small
   enough that a chatty ruleset cannot grow it without limit. */
const MATCHED_LOG_MAX = 500;

interface NormRule {
  id: number;
  priority: number;
  actionType:
    | "block"
    | "allow"
    | "modifyHeaders"
    | "redirect"
    | "upgradeScheme"
    | "allowAllRequests";
  redirectUrl: string | null;
  requestHeaders: DnrModifyHeaderOp[];
  responseHeaders: DnrModifyHeaderOp[];
  urlRe: RegExp | null;
  resourceTypes: Set<string> | null;
  domains: string[] | null;
  excludedDomains: Set<string> | null;
  initiatorDomains: string[] | null;
  excludedInitiatorDomains: Set<string> | null;
  requestMethods: Set<string> | null;
  raw: unknown;
  /* static rules carry the ruleset id they loaded from (#521) */
  rulesetId?: string;
}

/* ---- validation ---- */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strDomainArr(v: unknown, field: string): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) throw new Error("zeolite: rule condition." + field + " must be an array of strings");
  const out: string[] = [];
  for (const d of v) {
    if (typeof d !== "string" || d.length === 0) {
      throw new Error("zeolite: rule condition." + field + " entries must be non-empty strings");
    }
    out.push(d.toLowerCase());
  }
  return out;
}

/** urlFilter to an anchored-or-substring regex: leading | anchors the
    URL start, trailing | the URL end, * is any characters, ^ is
    Chrome's separator (end of URL or any char that is not alphanumeric,
    underscore, dash, dot or percent). Everything else is literal. */
export function urlFilterToRegex(filter: string): RegExp {
  const anchoredStart = filter.startsWith("|");
  const anchoredEnd = filter.length > 1 && filter.endsWith("|");
  const body = filter.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
  let src = "";
  for (const c of body) {
    if (c === "*") src += "[\\s\\S]*";
    else if (c === "^") src += "(?:$|[^\\w\\-.%])";
    else src += c.replace(/[|.*+?^${}()[\]\\]/g, "\\$&");
  }
  return new RegExp((anchoredStart ? "^" : "") + src + (anchoredEnd ? "$" : ""));
}

function validateHeaderOps(v: unknown, field: string): DnrModifyHeaderOp[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("zeolite: rule action." + field + " must be an array");
  const out: DnrModifyHeaderOp[] = [];
  for (const op of v) {
    if (!isObj(op)) throw new Error("zeolite: rule action." + field + " entries must be objects");
    const header = op.header;
    const operation = op.operation;
    const value = op.value;
    if (typeof header !== "string" || header.length === 0) {
      throw new Error("zeolite: rule action." + field + ".header must be a non-empty string");
    }
    if (operation !== "set" && operation !== "remove" && operation !== "append") {
      throw new Error("zeolite: rule action." + field + ".operation must be set, remove or append");
    }
    if (operation !== "remove" && typeof value !== "string") {
      throw new Error("zeolite: rule action." + field + " " + operation + " requires a string value");
    }
    out.push({ header, operation, value: typeof value === "string" ? value : undefined });
  }
  return out;
}

/** Validate one caller-supplied rule. Throws a descriptive error;
     the returned rule is normalized for matching and keeps a deep
     clone of the validated input for the getters. */
export function validateRule(v: unknown): NormRule {
  if (!isObj(v)) throw new Error("zeolite: rule must be an object");
  const id = v.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("zeolite: rule.id must be an integer >= 1");
  }
  let priority = 1;
  if (v.priority !== undefined) {
    if (typeof v.priority !== "number" || !Number.isInteger(v.priority) || v.priority < 1) {
      throw new Error("zeolite: rule.priority must be an integer >= 1");
    }
    priority = v.priority;
  }
  const actionRaw = v.action;
  if (!isObj(actionRaw)) throw new Error("zeolite: rule.action must be an object");
  const actionType = actionRaw.type;
  if (
    actionType !== "block" && actionType !== "allow" && actionType !== "modifyHeaders" &&
    actionType !== "redirect" && actionType !== "upgradeScheme" && actionType !== "allowAllRequests"
  ) {
    throw new Error(
      "zeolite: rule.action.type must be block, allow, modifyHeaders, redirect, upgradeScheme or allowAllRequests",
    );
  }
  /* #521 slice 3: upgradeScheme takes no payload (the upgrade target
     is derived from the request URL); allowAllRequests likewise. */
  if ((actionType === "upgradeScheme" || actionType === "allowAllRequests") && actionRaw.redirect !== undefined) {
    throw new Error("zeolite: rule action '" + actionType + "' does not take a redirect object");
  }
  /* #521 slice 2: redirect re-enters the engine pipeline (the new
     destination becomes the proxied target, never a native
     navigation), so an absolute http(s) redirect.url is safe to
     accept. transform and regexSubstitution stay refused: the engine
     does not re-derive destinations from patterns. */
  let redirectUrl: string | null = null;
  if (actionType === "redirect") {
    const rd = actionRaw.redirect;
    if (!isObj(rd)) throw new Error("zeolite: rule action 'redirect' requires a redirect object");
    if (rd.transform !== undefined || rd.regexSubstitution !== undefined) {
      throw new Error("zeolite: rule action 'redirect' supports only an absolute redirect.url; transform and regexSubstitution are not supported");
    }
    if (typeof rd.url !== "string") throw new Error("zeolite: rule action 'redirect'.url must be a string");
    let ru: URL;
    try {
      ru = new URL(rd.url);
    } catch {
      throw new Error("zeolite: rule action 'redirect'.url must be an absolute URL");
    }
    if (ru.protocol !== "https:" && ru.protocol !== "http:") {
      throw new Error("zeolite: rule action 'redirect'.url must be an http(s) URL");
    }
    redirectUrl = rd.url;
  }
  const conditionRaw = v.condition;
  if (conditionRaw !== undefined && !isObj(conditionRaw)) {
    throw new Error("zeolite: rule.condition must be an object");
  }
  const c: Record<string, unknown> = conditionRaw ?? {};
  let urlRe: RegExp | null = null;
  const hasFilter = c.urlFilter !== undefined;
  const hasRegex = c.regexFilter !== undefined;
  if (hasFilter && hasRegex) {
    throw new Error("zeolite: rule condition cannot set both urlFilter and regexFilter");
  }
  if (hasFilter) {
    if (typeof c.urlFilter !== "string") throw new Error("zeolite: rule condition.urlFilter must be a string");
    urlRe = urlFilterToRegex(c.urlFilter);
  } else if (hasRegex) {
    if (typeof c.regexFilter !== "string" || c.regexFilter.length === 0) {
      throw new Error("zeolite: rule condition.regexFilter must be a non-empty string");
    }
    try {
      urlRe = new RegExp(c.regexFilter);
    } catch {
      throw new Error("zeolite: rule condition.regexFilter does not compile");
    }
  }
  let resourceTypes: Set<string> | null = null;
  if (c.resourceTypes !== undefined) {
    if (!Array.isArray(c.resourceTypes) || c.resourceTypes.length === 0) {
      throw new Error("zeolite: rule condition.resourceTypes must be a non-empty array");
    }
    resourceTypes = new Set<string>();
    for (const t of c.resourceTypes) {
      if (typeof t !== "string" || !RESOURCE_TYPES.has(t)) {
        throw new Error("zeolite: rule condition.resourceTypes contains an unknown type: " + JSON.stringify(t));
      }
      resourceTypes.add(t);
    }
  }
  const domains = strDomainArr(c.domains, "domains");
  const excludedDomains = strDomainArr(c.excludedDomains, "excludedDomains");
  const initiatorDomains = strDomainArr(c.initiatorDomains, "initiatorDomains");
  const excludedInitiatorDomains = strDomainArr(c.excludedInitiatorDomains, "excludedInitiatorDomains");
  let requestMethods: Set<string> | null = null;
  if (c.requestMethods !== undefined) {
    if (!Array.isArray(c.requestMethods)) {
      throw new Error("zeolite: rule condition.requestMethods must be an array of strings");
    }
    requestMethods = new Set<string>();
    for (const m of c.requestMethods) {
      if (typeof m !== "string" || m.length === 0) {
        throw new Error("zeolite: rule condition.requestMethods entries must be non-empty strings");
      }
      requestMethods.add(m.toUpperCase());
    }
  }
  return {
    id,
    priority,
    actionType,
    redirectUrl,
    requestHeaders: validateHeaderOps(actionRaw.requestHeaders, "requestHeaders"),
    responseHeaders: validateHeaderOps(actionRaw.responseHeaders, "responseHeaders"),
    urlRe,
    resourceTypes,
    domains,
    excludedDomains: excludedDomains ? new Set(excludedDomains) : null,
    initiatorDomains,
    excludedInitiatorDomains: excludedInitiatorDomains ? new Set(excludedInitiatorDomains) : null,
    requestMethods,
    raw: JSON.parse(JSON.stringify(v)),
  };
}

/* ---- matching ---- */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Domain matching per MDN: the host equals the value or is a
    subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

function matchRule(r: NormRule, f: DnrRequestFacts): boolean {
  const host = hostOf(f.url);
  if (host === null) return false;
  if (r.urlRe !== null && !r.urlRe.test(f.url)) return false;
  if (r.resourceTypes !== null && !r.resourceTypes.has(f.type)) return false;
  if (r.requestMethods !== null && !r.requestMethods.has(f.method.toUpperCase())) return false;
  if (r.domains !== null && !r.domains.some((d) => domainMatches(host, d))) return false;
  if (r.excludedDomains !== null) {
    for (const d of r.excludedDomains) if (domainMatches(host, d)) return false;
  }
  if (r.initiatorDomains !== null) {
    const initHost = f.initiator ? hostOf(f.initiator) : null;
    if (initHost === null) return false;
    if (!r.initiatorDomains.some((d) => domainMatches(initHost, d))) return false;
  }
  if (r.excludedInitiatorDomains !== null && f.initiator) {
    const initHost = hostOf(f.initiator);
    if (initHost !== null) {
      for (const d of r.excludedInitiatorDomains) if (domainMatches(initHost, d)) return false;
    }
  }
  return true;
}

/* ---- #521 slice 3: allowAllRequests frame bypass ---- */

/* Chrome scopes allowAllRequests to the matched frame's subtree. The
   engine request facts carry no frame ids, so the bypass keys on the
   document ORIGIN the facts do carry: the initiator origin for
   requests generated from the matched document (subresources and
   descendant-frame loads) and the request URL origin for the matched
   main_frame/sub_frame load itself. Documented divergence: a
   different document on the same origin inherits the bypass until it
   expires, and the TTL stands in for frame destruction. */
const BYPASS_TTL_MS = 10 * 60_000;
const BYPASS_MAX_ORIGINS = 256;

/** The upgradeScheme target: the same URL over https (ws over wss).
    Already-secure or non-special schemes have no effect (null). */
function upgradeSchemeTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  else if (u.protocol === "ws:") u.protocol = "wss:";
  else return null;
  return u.href;
}

/* ---- registry ---- */

interface StaticCacheEntry {
  key: string;
  rules: NormRule[];
  load: Promise<void>;
}

export class DnrRegistry {
  private readonly dynamic = new Map<ExtensionId, Map<number, NormRule>>();
  private readonly session = new Map<ExtensionId, Map<number, NormRule>>();
  /* The full enabled-ruleset set once updateEnabledRulesets ran; the
     manifest defaults apply until then. Persisted with the dynamic
     rules. */
  private readonly enabledStatic = new Map<ExtensionId, Set<string>>();
  private readonly staticCache = new Map<ExtensionId, StaticCacheEntry>();
  private provider: DnrPermProvider | null = null;
  /* #594 pattern: hydration state and the in-flight persistence writes
     so tests (and the boot path) can await a settled store. */
  private hydrated = false;
  private readonly inflight = new Set<Promise<void>>();
  /* #521 introspection: the bounded match log and the
     onRuleMatchedDebug listeners. */
  private readonly matchedLog: DnrMatchedRule[] = [];
  private readonly matchedListeners = new Set<(m: DnrMatchedRule) => void>();
  /* #521 slice 3: per-extension allowAllRequests frame bypass:
     origin -> { priority, until }. */
  private readonly frameBypass = new Map<ExtensionId, Map<string, { priority: number; until: number }>>();

  setPermProvider(p: DnrPermProvider): void {
    this.provider = p;
  }

  /* Source ranks for the equal-priority equal-action tie-break:
     session beats dynamic beats static (Firefox). */
  private bestMatch(
    f: DnrRequestFacts,
    v: DnrExtView,
    st: NormRule[] | null,
    bypass: { priority: number } | null,
  ): { rule: NormRule; source: DnrMatchSource } | null {
    let best: NormRule | null = null;
    let bestRank = 0;
    let bestClass = 0;
    let bestSource: DnrMatchSource = "dynamic";
    const consider = (r: NormRule, rank: number): void => {
      if (!matchRule(r, f)) return;
      /* #521 slice 3: a live allowAllRequests bypass of higher or
         equal priority silences this extension's rules on the
         request (Chrome: the extension has no effect on it). */
      if (bypass !== null && r.priority <= bypass.priority) return;
      const cls = ACTION_CLASS[r.actionType] ?? 9;
      const cur = best;
      if (
        cur === null ||
        r.priority > cur.priority ||
        (r.priority === cur.priority && (cls < bestClass || (cls === bestClass && rank < bestRank)))
      ) {
        best = r;
        bestRank = rank;
        bestClass = cls;
        bestSource = rank === 0 ? "session" : rank === 1 ? "dynamic" : "static";
      }
    };
    for (const r of this.session.get(v.id)?.values() ?? []) consider(r, 0);
    for (const r of this.dynamic.get(v.id)?.values() ?? []) consider(r, 1);
    for (const r of st ?? []) consider(r, 2);
    return best === null ? null : { rule: best, source: bestSource };
  }

  private effectiveEnabled(v: DnrExtView, rs: DnrRulesetSpec): boolean {
    const snap = this.enabledStatic.get(v.id);
    return snap ? snap.has(rs.id) : rs.enabled;
  }

  /** Load the enabled static rulesets of one extension from the stored
      package, once per enabled-set signature. Missing files, corrupt
      JSON and invalid rules are silently skipped, exactly as Firefox
      documents for static rulesets; the load never throws. */
  private ensureStatic(v: DnrExtView): StaticCacheEntry {
    const enabled = v.staticRulesets.filter((rs) => this.effectiveEnabled(v, rs));
    const key = enabled.map((rs) => rs.id).sort().join("\u0000");
    const existing = this.staticCache.get(v.id);
    if (existing && existing.key === key) return existing;
    const rules: NormRule[] = [];
    const entry: StaticCacheEntry = { key, rules, load: Promise.resolve() };
    entry.load = (async () => {
      try {
        const db = await openDb();
        for (const rs of enabled) {
          let bytes = await idbGet(db, STORE_FILES, v.id + ":" + rs.path);
          if (!(bytes instanceof Uint8Array)) bytes = await idbGet(db, STORE_FILES, v.id + ":/" + rs.path);
          if (!(bytes instanceof Uint8Array)) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            continue;
          }
          const arr = Array.isArray(parsed)
            ? parsed
            : isObj(parsed) && Array.isArray(parsed.rules)
              ? (parsed.rules as unknown[])
              : null;
          if (arr === null) continue;
          for (const item of arr) {
            try {
              const nr = validateRule(item);
              nr.rulesetId = rs.id;
              rules.push(nr);
            } catch {
              /* an invalid static rule is silently ignored */
            }
          }
        }
      } catch {
        /* no IndexedDB or a broken store: static rules honestly skip */
      }
    })();
    this.staticCache.set(v.id, entry);
    return entry;
  }

  /** Engine hook: the full verdict for one request. A block from any
      enabled extension wins immediately (block beats redirect across
      extensions); a redirect or scheme upgrade is taken from the
      first extension in provider order whose best matching rule
      redirects or upgrades (slice 3: upgradeScheme rides this
      seam). With the WithHostAccess permission, block, upgradeScheme
      and redirect alike require a host permission on the request
      URL. An allowAllRequests match arms the frame bypass and lets
      the request proceed. Async only because static rulesets load
      lazily on first use. */
  async decideRequestVerdict(f: DnrRequestFacts): Promise<DnrVerdict> {
    const views = this.provider?.() ?? [];
    let redirect: string | null = null;
    for (const v of views) {
      if (!v.enabled) continue;
      const dyn = this.dynamic.get(v.id);
      const ses = this.session.get(v.id);
      let st: NormRule[] | null = null;
      if (v.staticRulesets.length > 0) {
        const entry = this.ensureStatic(v);
        await entry.load;
        st = entry.rules;
      }
      if (!dyn && !ses && !(st && st.length > 0)) continue;
      /* #521 slice 3: a live allowAllRequests bypass minted by this
         extension silences its own equal-or-lower-priority rules on
         requests generated from the bypassed document. */
      const bypass = this.liveBypass(v, f);
      if (bypass !== null && f.type === "sub_frame") {
        /* the subframe document joins the bypassed subtree: its own
           subresources are generated from it. */
        this.armBypass(v.id, originOf(f.url), bypass.priority);
      }
      const best = this.bestMatch(f, v, st, bypass);
      if (best === null) continue;
      if (best.rule.actionType === "block") {
        /* With the WithHostAccess permission even a block requires a
           host permission on the request URL. */
        if (v.withHostAccess && !hostPatternsMatch(v.hosts, f.url)) continue;
        this.recordMatch(v, best.rule, best.source, f, "block");
        return { kind: "block" };
      }
      /* #521 slice 3: upgradeScheme rides the slice-2 redirect seam
         (same host, https scheme, engine-internal re-entry); the
         host-permission gate is identical to block/redirect. An
         already-secure target has no effect. */
      if (best.rule.actionType === "upgradeScheme" && redirect === null) {
        if (v.withHostAccess && !hostPatternsMatch(v.hosts, f.url)) continue;
        const up = upgradeSchemeTarget(f.url);
        if (up !== null) {
          this.recordMatch(v, best.rule, best.source, f, "redirect", up);
          redirect = up;
        }
      }
      /* #521 slice 3: allowAllRequests arms the frame bypass and lets
         the request proceed. Only a main_frame or sub_frame match
         arms (MDN scopes the action to those types); on other types
         it acts as plain allow. Other extensions keep their
         verdicts. */
      if (best.rule.actionType === "allowAllRequests") {
        if (v.withHostAccess && !hostPatternsMatch(v.hosts, f.url)) continue;
        if (f.type === "main_frame" || f.type === "sub_frame") {
          this.armBypass(v.id, originOf(f.url), best.rule.priority);
        }
      }
      if (best.rule.actionType === "redirect" && redirect === null) {
        if (v.withHostAccess && !hostPatternsMatch(v.hosts, f.url)) continue;
        this.recordMatch(v, best.rule, best.source, f, "redirect", best.rule.redirectUrl ?? undefined);
        redirect = best.rule.redirectUrl;
      }
    }
    return redirect !== null ? { kind: "redirect", url: redirect } : { kind: "none" };
  }

  /** Engine hook: true when any enabled extension's best matching rule
      is a block its permissions allow. Async only because static
      rulesets load lazily on first use. */
  async decideRequest(f: DnrRequestFacts): Promise<boolean> {
    return (await this.decideRequestVerdict(f)).kind === "block";
  }

  /** #521 introspection: record one engine-visible match in the
      bounded log and notify onRuleMatchedDebug listeners. Only
      effective verdicts are recorded (the block that returned, the
      redirect that was taken); a broken debug listener never
      affects the pipeline. */
  private recordMatch(v: DnrExtView, r: NormRule, source: DnrMatchSource, f: DnrRequestFacts, kind: "block" | "redirect", redirectUrl?: string): void {
    const rec: DnrMatchedRule = {
      extensionId: v.id,
      ruleId: r.id,
      rulesetId: r.rulesetId ?? (source === "dynamic" ? "_dynamic" : source === "session" ? "_session" : "_static"),
      source,
      url: f.url,
      method: f.method,
      type: f.type,
      kind,
      timestamp: Date.now(),
    };
    if (redirectUrl !== undefined) rec.redirectUrl = redirectUrl;
    this.matchedLog.push(rec);
    if (this.matchedLog.length > MATCHED_LOG_MAX) this.matchedLog.shift();
    for (const l of this.matchedListeners) {
      try {
        l(rec);
      } catch {
        /* a broken debug listener is swallowed */
      }
    }
  }

  /** #521 introspection: the bounded log of engine-visible matches,
      oldest first. Chrome's tabId and minMatchId filters are not
      provided: the engine request facts carry no tab id, and the
      log is already bounded. modifyHeaders matches are not
      recorded. */
  async getMatchedRules(): Promise<DnrMatchedRule[]> {
    return this.matchedLog.slice();
  }

  /** #521 introspection: fires for every engine-visible match (the
      effective block or redirect verdict). The API mount gates this
      on the declarativeNetRequestFeedback permission (Chrome's
      documented gate); the registry itself stays ungated. */
  readonly onRuleMatchedDebug = {
    addListener: (l: (m: DnrMatchedRule) => void): void => {
      this.matchedListeners.add(l);
    },
    removeListener: (l: (m: DnrMatchedRule) => void): void => {
      this.matchedListeners.delete(l);
    },
    hasListener: (l: (m: DnrMatchedRule) => void): boolean => this.matchedListeners.has(l),
  };

  /* ---- #521 slice 3: allowAllRequests frame bypass ---- */

  /** The live bypass this extension minted for the document the
      request is generated from (the initiator origin), if any. */
  private liveBypass(v: DnrExtView, f: DnrRequestFacts): { priority: number; until: number } | null {
    const map = this.frameBypass.get(v.id);
    if (!map || map.size === 0) return null;
    const initOrigin = f.initiator ? originOf(f.initiator) : null;
    if (initOrigin === null) return null;
    const e = map.get(initOrigin);
    if (!e || e.until <= Date.now()) return null;
    return e;
  }

  /** Arm (or refresh) the frame bypass for one origin. Bounded:
      drop-oldest past BYPASS_MAX_ORIGINS; delete-then-set refreshes
      recency (the #229/#358 LRU rule). */
  private armBypass(id: ExtensionId, origin: string | null, priority: number): void {
    if (origin === null) return;
    let map = this.frameBypass.get(id);
    if (!map) {
      map = new Map();
      this.frameBypass.set(id, map);
    }
    map.delete(origin);
    map.set(origin, { priority, until: Date.now() + BYPASS_TTL_MS });
    while (map.size > BYPASS_MAX_ORIGINS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** Host-permission gate for header operations: the request URL
      always, the initiator origin too for sub_frame requests. */
  private modifyAllowed(v: DnrExtView, f: DnrRequestFacts): boolean {
    if (!hostPatternsMatch(v.hosts, f.url)) return false;
    if (f.type === "sub_frame" && f.initiator && !hostPatternsMatch(v.hosts, f.initiator)) return false;
    return true;
  }

  private walkHeaderOps(f: DnrRequestFacts, pick: (r: NormRule) => DnrModifyHeaderOp[]): { v: DnrExtView; ops: DnrModifyHeaderOp[] }[] {
    const out: { v: DnrExtView; ops: DnrModifyHeaderOp[] }[] = [];
    for (const v of this.provider?.() ?? []) {
      if (!v.enabled) continue;
      const dyn = this.dynamic.get(v.id);
      const ses = this.session.get(v.id);
      const cached = v.staticRulesets.length > 0 ? this.staticCache.get(v.id) : null;
      if (!dyn && !ses && !(cached && cached.rules.length > 0)) continue;
      const bypass = this.liveBypass(v, f);
      const best = this.bestMatch(f, v, cached ? cached.rules : null, bypass);
      if (best === null || best.rule.actionType !== "modifyHeaders") continue;
      if (!this.modifyAllowed(v, f)) continue;
      const ops = pick(best.rule);
      if (ops.length > 0) out.push({ v, ops });
    }
    return out;
  }

  /** Engine hook: apply DNR request-header operations in place, before
      webRequest listeners see the header set. Static rulesets that have
      not loaded yet are skipped; in the fetch pipeline the block hook
      runs first, so by the time headers are forwarded every enabled
      static set is loaded. */
  applyRequestHeaders(f: DnrRequestFacts, headers: Headers): void {
    for (const { ops } of this.walkHeaderOps(f, (r) => r.requestHeaders)) applyOps(headers, ops);
  }

  /** Engine hook: same for response headers. */
  applyResponseHeaders(f: DnrRequestFacts, headers: Headers): void {
    for (const { ops } of this.walkHeaderOps(f, (r) => r.responseHeaders)) applyOps(headers, ops);
  }

  /* ---- API methods (mutation is atomic: validation errors change
          nothing) ---- */

  private parseUpdate(update: unknown): { adds: NormRule[]; removes: number[] } {
    if (!isObj(update)) throw new Error("zeolite: update must be an object");
    const rawAdds = update.addRules === undefined ? [] : update.addRules;
    if (!Array.isArray(rawAdds)) throw new Error("zeolite: addRules must be an array");
    const adds = rawAdds.map(validateRule);
    const seen = new Set<number>();
    for (const r of adds) {
      if (seen.has(r.id)) throw new Error("zeolite: duplicate rule id " + r.id + " in addRules");
      seen.add(r.id);
    }
    const removes: number[] = [];
    const rawRemoves = update.removeRuleIds === undefined ? [] : update.removeRuleIds;
    if (!Array.isArray(rawRemoves)) throw new Error("zeolite: removeRuleIds must be an array");
    for (const id of rawRemoves) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("zeolite: removeRuleIds entries must be integers");
      }
      removes.push(id);
    }
    return { adds, removes };
  }

  async updateDynamicRules(id: ExtensionId, update: unknown): Promise<void> {
    const { adds, removes } = this.parseUpdate(update);
    const map = this.dynamic.get(id) ?? new Map<number, NormRule>();
    const surviving = new Set(map.keys());
    for (const rid of removes) surviving.delete(rid);
    for (const r of adds) {
      if (surviving.has(r.id)) throw new Error("zeolite: dynamic rule id " + r.id + " already exists");
    }
    const newSize = surviving.size + adds.length;
    const sessionCount = this.session.get(id)?.size ?? 0;
    if (newSize + sessionCount > MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES) {
      throw new Error("zeolite: dynamic and session rules exceed the " + MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES + " rule quota");
    }
    for (const rid of removes) map.delete(rid);
    for (const r of adds) map.set(r.id, r);
    this.dynamic.set(id, map);
    this.persist(id);
  }

  updateSessionRules(id: ExtensionId, update: unknown): void {
    const { adds, removes } = this.parseUpdate(update);
    const map = this.session.get(id) ?? new Map<number, NormRule>();
    const surviving = new Set(map.keys());
    for (const rid of removes) surviving.delete(rid);
    for (const r of adds) {
      if (surviving.has(r.id)) throw new Error("zeolite: session rule id " + r.id + " already exists");
    }
    const dynamicCount = this.dynamic.get(id)?.size ?? 0;
    if (surviving.size + adds.length + dynamicCount > MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES) {
      throw new Error("zeolite: dynamic and session rules exceed the " + MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES + " rule quota");
    }
    for (const rid of removes) map.delete(rid);
    for (const r of adds) map.set(r.id, r);
    this.session.set(id, map);
  }

  getDynamicRules(id: ExtensionId): unknown[] {
    const out: unknown[] = [];
    for (const r of this.dynamic.get(id)?.values() ?? []) out.push(JSON.parse(JSON.stringify(r.raw)));
    return out;
  }

  getSessionRules(id: ExtensionId): unknown[] {
    const out: unknown[] = [];
    for (const r of this.session.get(id)?.values() ?? []) out.push(JSON.parse(JSON.stringify(r.raw)));
    return out;
  }

  async updateEnabledRulesets(id: ExtensionId, update: unknown): Promise<void> {
    if (!isObj(update)) throw new Error("zeolite: update must be an object");
    const view = (this.provider?.() ?? []).find((v) => v.id === id) ?? null;
    const known = view ? new Set(view.staticRulesets.map((rs) => rs.id)) : new Set<string>();
    let set = this.enabledStatic.get(id);
    if (!set) {
      set = new Set<string>();
      if (view) {
        for (const rs of view.staticRulesets) if (rs.enabled) set.add(rs.id);
      }
    }
    const next = new Set(set);
    const checkIds = (v: unknown, field: string): void => {
      if (v === undefined) return;
      if (!Array.isArray(v)) throw new Error("zeolite: " + field + " must be an array of strings");
      for (const rid of v) {
        if (typeof rid !== "string" || !known.has(rid)) {
          throw new Error("zeolite: unknown static ruleset id " + JSON.stringify(rid));
        }
        if (field === "enableRulesetIds") next.add(rid);
        else next.delete(rid);
      }
    };
    checkIds(update.disableRulesetIds, "disableRulesetIds");
    checkIds(update.enableRulesetIds, "enableRulesetIds");
    if (next.size > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
      throw new Error("zeolite: enabled static rulesets exceed the " + MAX_NUMBER_OF_ENABLED_STATIC_RULESETS + " ruleset quota");
    }
    this.enabledStatic.set(id, next);
    this.staticCache.delete(id);
    this.persist(id);
  }

  /** Chrome's getEnabledRulesets shape: ruleset id to disabled flag. */
  getEnabledRulesets(id: ExtensionId): Record<string, { disabled: boolean }> {
    const view = (this.provider?.() ?? []).find((v) => v.id === id) ?? null;
    const out: Record<string, { disabled: boolean }> = {};
    if (!view) return out;
    for (const rs of view.staticRulesets) out[rs.id] = { disabled: !this.effectiveEnabled(view, rs) };
    return out;
  }

  async getAvailableStaticRuleCount(id: ExtensionId): Promise<number> {
    const view = (this.provider?.() ?? []).find((v) => v.id === id) ?? null;
    if (!view || view.staticRulesets.length === 0) return GUARANTEED_MINIMUM_STATIC_RULES;
    const entry = this.ensureStatic(view);
    await entry.load;
    return Math.max(0, GUARANTEED_MINIMUM_STATIC_RULES - entry.rules.length);
  }

  /* ---- persistence (#594's alarms pattern) ---- */

  private persist(id: ExtensionId): void {
    if (!this.hydrated) {
      /* pre-hydration writes would clobber boot state with partials */
      return;
    }
    const p = openDb()
      .then((db) =>
        idbPut(db, STORE_DNR, id, {
          dynamic: this.getDynamicRules(id),
          enabledStatic: [...(this.enabledStatic.get(id) ?? [])],
        }),
      )
      .catch(() => undefined);
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
    });
  }

  /** Load the persisted dynamic rules and enabled-ruleset snapshots at
      worker boot. Merge-guarded; a broken store degrades honestly to
      in-memory rules, exactly like the alarms table. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true; /* set first: mutations from here on persist */
    try {
      const db = await openDb();
      const keys = await idbGetAllKeys(db, STORE_DNR);
      for (const extId of keys) {
        const rec = await idbGet(db, STORE_DNR, extId);
        if (!isObj(rec)) continue;
        const dynamic = Array.isArray(rec.dynamic) ? rec.dynamic : [];
        const map = new Map<number, NormRule>();
        for (const item of dynamic) {
          try {
            const r = validateRule(item);
            map.set(r.id, r);
          } catch {
            /* a corrupted persisted rule is skipped, never trusted */
          }
        }
        if (map.size > 0) this.dynamic.set(extId, map);
        const enabled = Array.isArray(rec.enabledStatic) ? rec.enabledStatic : [];
        if (enabled.every((e) => typeof e === "string")) {
          this.enabledStatic.set(extId, new Set(enabled as string[]));
        }
      }
    } catch {
      /* no IndexedDB: in-memory rules only, the pre-persist behavior */
    }
  }

  /** Engine hook: drop everything an extension owned (uninstall). */
  async drop(id: ExtensionId): Promise<void> {
    this.dynamic.delete(id);
    this.session.delete(id);
    this.enabledStatic.delete(id);
    this.staticCache.delete(id);
    this.frameBypass.delete(id);
    try {
      const db = await openDb();
      await idbDelete(db, STORE_DNR, id);
    } catch {
      /* store gone; memory is already dropped */
    }
  }

  /** Tests: await every in-flight persistence write. */
  async flushForTests(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Tests only: drop all rule state and the provider. */
  resetForTests(): void {
    this.dynamic.clear();
    this.session.clear();
    this.enabledStatic.clear();
    this.staticCache.clear();
    this.provider = null;
    this.hydrated = false;
    this.inflight.clear();
    this.matchedLog.length = 0;
    this.matchedListeners.clear();
    this.frameBypass.clear();
  }
}

function applyOps(headers: Headers, ops: DnrModifyHeaderOp[]): void {
  for (const op of ops) {
    if (op.operation === "remove") headers.delete(op.header);
    else if (op.operation === "set") headers.set(op.header, op.value ?? "");
    else {
      const prev = headers.get(op.header);
      headers.set(op.header, prev !== null ? prev + ", " + (op.value ?? "") : (op.value ?? ""));
    }
  }
}

export const DNR = new DnrRegistry();
