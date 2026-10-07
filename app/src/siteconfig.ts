/* SiteConfig (Phase 3): per-site rules loaded from /siteconfig.kdl at
   engine origin. Every compat-suite failure becomes a rule here, never
   a hardcoded branch in the rewriter or SW.

   Grammar (KDL v2 subset, parser in kdl.ts):
     site "youtube.com" {
       inject "/hooks/yt.js"
       block "ad.doubleclick.net"
       plugins "strip-trackers"
       fingerprint "profile-data-or-node"
     }

   Matching: longest host-suffix wins (youtube.com matches
   www.youtube.com and music.youtube.com, but a more specific key
   like music.youtube.com wins over youtube.com). */

import { engineBindingError, resolveProfile, type FingerprintProfile } from "./fingerprint";
import { parseKdl, type KdlNode } from "./kdl";

export interface SiteRule {
  /** Script paths (engine-origin) injected into <head> after the
      bootstrap, userscript-style. */
  inject?: string[];
  /** Hosts whose subresource tags are dropped at rewrite time. */
  block?: string[];
  /** Plugin module names: loaded from /plugins/<name>.js. */
  plugins?: string[];
  /** #80: per-site FingerprintProfile, siteconfig DATA (the same
      object zl:fingerprint accepts). Resolved by the SW into the
      document init script and the upstream UA/Accept-Language for
      this host's traffic; the global profile wins over it. */
  fingerprint?: unknown;
}

export type SiteRules = Record<string, SiteRule>;

let cached: Promise<SiteRules> | null = null;

/** Fetch (and memoize for the SW lifetime) the site rules. A missing or
    malformed file means "no rules": the engine must still work. */
export function siteRules(): Promise<SiteRules> {
  if (!cached) {
    cached = (async () => {
      try {
        const resp = await fetch("/siteconfig.kdl", { cache: "no-cache" });
        if (!resp.ok) return {};
        const rules: SiteRules = {};
        for (const node of parseKdl(await resp.text())) {
          const host = node.args[0];
          if (node.name !== "site" || typeof host !== "string" || host.length === 0) {
            continue;
          }
          const rule: SiteRule = {};
          for (const child of node.children) {
            const strs = child.args.filter((a): a is string => typeof a === "string");
            if (child.name === "inject") rule.inject = strs;
            else if (child.name === "block") rule.block = strs;
            else if (child.name === "plugins") rule.plugins = strs;
            else if (child.name === "fingerprint") {
              const v = kdlNodeValue(child);
              if (v !== null) rule.fingerprint = v;
            }
          }
          rules[host] = rule;
        }
        return rules;
      } catch {
        return {};
      }
    })();
  }
  return cached;
}

/** Host of a target URL, lowercase; null for unparseable input. */
function hostOf(target: string): string | null {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Longest host-suffix match for a target URL. Empty rule when none. */
export function ruleFor(rules: SiteRules, target: string): SiteRule {
  const host = hostOf(target);
  if (!host) return {};
  let best: string | null = null;
  for (const key of Object.keys(rules)) {
    const k = key.toLowerCase();
    if (host === k || host.endsWith("." + k)) {
      if (best === null || k.length > best.length) best = k;
    }
  }
  return best ? rules[best] : {};
}

/** #80: resolve a rule's per-site FingerprintProfile (siteconfig
    data, not code). Null for absent data, invalid data, or a profile
    bound away from the live engine; never throws - bad site data must
    not break requests. */
export function ruleProfile(rule: SiteRule, engine: string): FingerprintProfile | null {
  if (!rule.fingerprint) return null;
  try {
    const p = resolveProfile(rule.fingerprint);
    return engineBindingError(p, engine) ? null : p;
  } catch {
    return null;
  }
}

/** #80: a fingerprint child node as profile data: children and props
    become an object, a single arg is the value, several args an
    array, none is null (no data). resolveProfile validates the
    result; bad site data must never break requests. */
function kdlNodeValue(node: KdlNode): unknown {
  const keys = Object.keys(node.props);
  if (node.children.length > 0 || keys.length > 0) {
    const obj: Record<string, unknown> = { ...node.props };
    for (const child of node.children) obj[child.name] = kdlNodeValue(child);
    return obj;
  }
  if (node.args.length === 1) return node.args[0] ?? null;
  return node.args.length > 0 ? node.args : null;
}
