/* Compatibility policy engine (#135, #136). Declarative KDL rules
   that let an operator override the default NativeTransit decision
   for narrowly scoped compatibility cases: a matching rule upgrades
   a request the default would transport natively onto the rewrite
   path. The route vocabulary is small on purpose ("rewrite",
   "native" (#138), "relay" (#137), "wisp" (#168)); required
   rewrites (documents,
   stylesheets, transformed scripts) cannot be demoted without
   breaking the page. KDL stays a small typed vocabulary here, not
   a scripting language.

   Grammar (KDL v2 subset, parser in kdl.ts):
     rule "short-id" priority=10 {
       match host="cdn.example.com" path="/assets/"  // both optional
       types "script" "fetch"                        // optional
       route "rewrite"                               // or "native" (#138), "relay" (#137), "wisp" (#168)
       reason "short operator explanation"           // optional
     }

   Precedence: highest priority wins; on equal priority the later
   rule wins (document order). The matching rule's id rides the
   transit decision, the fallback ring and the TRANSPORT_FALLBACK
   diagnostics. A missing file means "no policy" (defaults); a
   malformed file is rejected with a diagnostics event and the
   defaults stay active - routing never changes silently. */

import { parseKdl, type KdlNode } from "./kdl";
import { DIAG } from "./diag";
import type { ResourceType } from "./rules";

export interface PolicyRule {
  id: string;
  /** Higher wins; equal priority: the later rule wins. */
  priority: number;
  /** Exact hostname or any parent domain; null matches all hosts. */
  host: string | null;
  /** URL pathname prefix; null matches all paths. */
  path: string | null;
  /** Resource-type filter; null matches all types. */
  types: Set<ResourceType> | null;
  /** Short operator explanation for diagnostics. */
  reason: string | null;
  /** #138: "rewrite" upgrades native onto the rewrite path;
      "native" demotes the JS literal pass for proven hosts.
      #137: "relay" moves the fetch onto the embedder's network
      stack for TLS-fingerprint-blocked hosts.
      #168: "wisp" rides the engine's own wisp transport through
      the PUBLIC wisp endpoint the embedder announces
      (zl:wispRegister) for hosts that refuse the relay class. */
  route: "rewrite" | "native" | "relay" | "wisp";
}

export interface CompiledPolicy {
  rules: PolicyRule[];
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "document",
  "script",
  "style",
  "image",
  "font",
  "media",
  "websocket",
  "worker",
  "manifest",
  "eventsource",
  "wasm",
  "fetch",
  "other",
]);

function child(node: KdlNode, name: string): KdlNode | undefined {
  return node.children.find((c) => c.name === name);
}

function matchProp(ruleId: string, key: string, v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error('policy: rule "' + ruleId + '": match ' + key + ' must be a non-empty string');
  }
  return v;
}

/** Parse + validate a policy document. KDL syntax errors carry
    the parser's line number; semantic errors name the rule. Throws
    on anything ambiguous instead of half-applying a file. */
export function compilePolicy(source: string): CompiledPolicy {
  const doc = parseKdl(source);
  const rules: PolicyRule[] = [];
  const seen = new Set<string>();
  for (const node of doc) {
    if (node.name !== "rule") {
      throw new Error('policy: unexpected node "' + node.name + '" (only rule nodes are allowed)');
    }
    const id = node.args[0];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("policy: rule needs a string id argument");
    }
    if (seen.has(id)) {
      throw new Error('policy: duplicate rule id "' + id + '"');
    }
    seen.add(id);
    const pr = node.props.priority;
    if (pr !== undefined && typeof pr !== "number") {
      throw new Error('policy: rule "' + id + '": priority must be a number');
    }
    for (const k of Object.keys(node.props)) {
      if (k !== "priority") {
        throw new Error('policy: rule "' + id + '": unexpected property "' + k + '" (only priority)');
      }
    }
    const m = child(node, "match");
    if (m && Object.keys(m.props).some((k) => k !== "host" && k !== "path")) {
      throw new Error('policy: rule "' + id + '": match allows only host and path properties');
    }
    const host = m ? matchProp(id, "host", m.props.host) : null;
    const path = m ? matchProp(id, "path", m.props.path) : null;
    /* Unknown children are checked first so a junk node reports
       itself, not a downstream missing-route error. */
    for (const c of node.children) {
      if (c.name !== "match" && c.name !== "types" && c.name !== "route" && c.name !== "reason") {
        throw new Error(
          'policy: rule "' + id + '": unexpected node "' + c.name + '" (allowed: match, types, route, reason)',
        );
      }
    }
    let types: Set<ResourceType> | null = null;
    const t = child(node, "types");
    if (t) {
      types = new Set();
      for (const a of t.args) {
        if (typeof a !== "string" || !KNOWN_TYPES.has(a)) {
          throw new Error('policy: rule "' + id + '": unknown resource type ' + JSON.stringify(a));
        }
        types.add(a as ResourceType);
      }
      if (types.size === 0) types = null;
    }
    const rv = child(node, "route")?.args[0];
    if (rv !== "rewrite" && rv !== "native" && rv !== "relay" && rv !== "wisp") {
      throw new Error(
        'policy: rule "' + id + '": route must be "rewrite", "native", "relay" or "wisp"',
      );
    }
    let reason: string | null = null;
    const rsn = child(node, "reason");
    if (rsn) {
      const v = rsn.args[0];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error('policy: rule "' + id + '": reason must be a non-empty string');
      }
      reason = v;
    }
    rules.push({
      id,
      priority: typeof pr === "number" ? pr : 0,
      host: host ? host.toLowerCase() : null,
      path,
      types,
      reason,
      route: rv,
    });
  }
  return { rules };
}

/** The one rule a request matches: highest priority wins, equal
    priority means the later rule wins (document order).
    Deterministic and side-effect free. */
export function policyMatch(p: CompiledPolicy, url: string, rtype: ResourceType): PolicyRule | null {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return null;
  }
  let best: PolicyRule | null = null;
  for (const r of p.rules) {
    if (r.host !== null && host !== r.host && !host.endsWith("." + r.host)) continue;
    if (r.path !== null && !path.startsWith(r.path)) continue;
    if (r.types !== null && !r.types.has(rtype)) continue;
    if (best === null || r.priority >= best.priority) best = r;
  }
  return best;
}

/* #487: behavior rules must not compete with network transport rules.
   Previously policyMatch() could choose a high-priority relay/wisp
   rule ahead of a lower-priority native/rewrite rule, accidentally
   disabling the intended content behavior. Transport selection still
   uses transportMatch() independently below. */
export function behaviorMatch(p: CompiledPolicy, url: string, rtype: ResourceType): PolicyRule | null {
  const behaviors = p.rules.filter((r) => r.route === "native" || r.route === "rewrite");
  return behaviors.length === 0 ? null : policyMatch({ rules: behaviors }, url, rtype);
}

/* #154: transport-side view of the same rules. route "native" and
   route "rewrite" choose a response's rewrite behavior (literal pass
   demotion, rewrite upgrade); route "relay" and route "wisp" choose
   the wire. A behavior rule winning the match must not also capture
   the transport: on a relay-only deployment a "native" host rule
   would otherwise demote its requests onto the default wasm wisp
   transport the deployment refuses. upstreamFetch matches transports
   only, so behavior rules compose with the transport rules (a
   match-less default-relay still carries behavior-ruled hosts). */
export function transportMatch(p: CompiledPolicy, url: string, rtype: ResourceType): PolicyRule | null {
  const transports = p.rules.filter((r) => r.route === "relay" || r.route === "wisp");
  return transports.length === 0 ? null : policyMatch({ rules: transports }, url, rtype);
}

/* Load /policy.kdl once per worker lifetime, like /rules.kdl. A
   missing file means "no policy" (the default); a malformed file
   is rejected loudly and the defaults stay active. */
let cached: Promise<CompiledPolicy> | null = null;

export function loadPolicy(): Promise<CompiledPolicy> {
  if (!cached) {
    cached = (async () => {
      try {
        const resp = await fetch("/policy.kdl", { cache: "no-cache" });
        /* A 5xx is a transient failure, not a missing file: forget the
           memo so the next request retries. A 404 stays memoized. */
        if (resp.status >= 500) cached = null;
        if (!resp.ok) return { rules: [] };
        return compilePolicy(await resp.text());
      } catch (e) {
        cached = null;
        DIAG.emit({
          category: "TRANSPORT",
          cause: "proxy",
          severity: "warning",
          message: "policy.kdl rejected; default transit decisions stay active",
          technicalReason: e instanceof Error ? e.message : String(e),
        });
        return { rules: [] };
      }
    })();
  }
  return cached;
}

/** Tests only: drop the memoized policy. */
export function policyResetForTests(): void {
  cached = null;
}