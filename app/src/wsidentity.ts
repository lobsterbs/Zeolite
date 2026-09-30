/* Per-origin virtual WS identities (deep-integration item 4).
 *
 * The WS bridge (1.3 Carbide) opened every page WebSocket with an
 * empty handshake header set: one identity for every proxied site, and
 * the wrong one at that - no Origin, no Cookie, no per-site UA. Sites
 * that authenticate the upgrade against a session cookie or check the
 * Origin saw a bridge-shaped handshake instead of the site-shaped one
 * a native page produces.
 *
 * This module assembles the handshake headers the same way the fetch
 * path does (sw.ts UPSTREAM_REQUEST): Origin from the initiator's
 * virtual origin, Cookie from the per-origin jar (the sole Cookie
 * source for engine requests), and the per-site UA override (zl:rules)
 * - with an active fingerprint profile winning, per the 1.8 Telluride
 * wire-surface invariant. ws:/wss: targets are mapped to http:/https:
 * for the jar and rule lookups (the jar only parses http(s), and the
 * bridge upgrades ws->wss before the transport anyway).
 *
 * The page never supplies headers itself: the control message carries
 * only the initiator origin, so a page cannot smuggle arbitrary
 * handshake headers onto the transport. */

import { siteUaFor } from "./rules";
import { cookieHeaderFor } from "./cookies";

/** Raw header pair shape the vendored transport connect() takes. */
export type WsHeaderPair = [string, string];

/** Fingerprint profile surface the handshake mirrors (Telluride). */
export interface WsIdentityProfile {
  userAgent: string;
  languages: string[];
}

export interface WsIdentityOpts {
  /** Active fingerprint profile, if any. Wins over the site UA and
   * also pins accept-language, like the fetch path does. */
  profile?: WsIdentityProfile | null;
  /** Test seam: UA lookup (defaults to the zl:rules overrides). */
  uaFor?: (url: string) => string | null;
  /** Test seam: jar Cookie lookup (defaults to the per-origin jar). */
  cookieFor?: (url: string) => string | null;
}

/** Map ws:/wss: to http:/https: for jar and per-site-rule lookups.
 * Anything else passes through untouched. */
export function wsTargetForLookups(targetUrl: string): string {
  try {
    const u = new URL(targetUrl);
    if (u.protocol === "ws:") return "http:" + targetUrl.slice("ws:".length);
    if (u.protocol === "wss:") return "https:" + targetUrl.slice("wss:".length);
  } catch {
    /* unparseable: callers validated the URL already; pass through */
  }
  return targetUrl;
}

/** Handshake headers for one bridged WebSocket. Pure; unit-gated in
 * __tests__/ws-identity.test.ts. */
export function wsIdentityHeaders(
  origin: string | null | undefined,
  targetUrl: string,
  opts?: WsIdentityOpts,
): WsHeaderPair[] {
  const out: WsHeaderPair[] = [];
  /* Origin: what a native page's upgrade request would carry - the
     initiator's own origin. Absent when the initiator did not
     identify itself (honest absence, never the engine origin). */
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.protocol === "https:" || o.protocol === "http:") {
        out.push(["origin", o.origin]);
      }
    } catch {
      /* malformed initiator origin: no Origin header */
    }
  }
  const lookupUrl = wsTargetForLookups(targetUrl);
  /* User-Agent: the per-site override from zl:rules, unless a
     fingerprint profile is active - then the profile's UA wins and
     accept-language matches too (wire surface = document surface). */
  const profile = opts?.profile ?? null;
  if (profile) {
    out.push(["user-agent", profile.userAgent]);
    out.push(["accept-language", profile.languages.join(",")]);
  } else {
    const uaFor = opts?.uaFor ?? siteUaFor;
    const ua = uaFor(lookupUrl);
    if (ua) out.push(["user-agent", ua]);
  }
  /* Cookie: the jar is the authoritative Cookie source for every
     engine-initiated request; a cookie-authenticated WS upgrade
     behaves like a native one. */
  const cookieFor = opts?.cookieFor ?? cookieHeaderFor;
  const cookie = cookieFor(lookupUrl);
  if (cookie) out.push(["cookie", cookie]);
  return out;
}
