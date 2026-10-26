/* #477 P0/P1: no guest execution. Canonical registration identity and
   scope matching only. Inputs from untrusted pages MUST first pass
   verified client/page context gates before reaching the registry.
   No use of short hashes, no access to kernel storage or transport. */

export interface GuestRegistrationIdentity {
  readonly origin: string;
  readonly scope: string;
  readonly scriptURL: string;
}

export function canonicalGuestRegistration(
  pageUrl: string,
  scriptInput: string,
  scopeInput?: string,
): GuestRegistrationIdentity {
  const page = new URL(pageUrl);
  if (!/^https?:$/.test(page.protocol)) throw new TypeError("Invalid virtual page origin");

  let script: URL;
  let scope: URL;
  try {
    script = new URL(scriptInput, page.href);
    scope = scopeInput === undefined ? new URL("./", script.href) : new URL(scopeInput, page.href);
  } catch {
    throw new TypeError("Invalid service worker registration URL");
  }
  if (script.origin !== page.origin || scope.origin !== page.origin ||
      !/^https?:$/.test(script.protocol) || !/^https?:$/.test(scope.protocol)) {
    throw new TypeError("Service Worker script and scope must share the verified page origin");
  }
  /* URL fragments never participate in scope identity. Encoded slash or
     backslash is rejected because path-based scope validation can be
     interpreted differently by a browser/server after decoding. */
  const badPath = /%(?:2f|5c)/i;
  if (badPath.test(script.pathname) || badPath.test(scope.pathname) ||
      script.hash || scope.hash || scope.search || script.username || script.password) {
    throw new TypeError("Invalid Service Worker script or scope");
  }
  return { origin: page.origin, scriptURL: script.href, scope: scope.href };
}

/** Validate persisted data before exposing it; parsing a JSON object or
    matching scope origin alone does not prove scriptURL is safe. */
export function validateStoredGuestRegistration(
  pageUrl: string,
  record: unknown,
): GuestRegistrationIdentity | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (typeof r.scriptURL !== "string" || typeof r.scope !== "string") return null;
  try {
    const v = canonicalGuestRegistration(pageUrl, r.scriptURL, r.scope);
    if (v.scriptURL !== r.scriptURL || v.scope !== r.scope) return null;
    return v;
  } catch {
    return null;
  }
}

/** Exact origin and path-prefix boundary; /app/ never captures /apple.
    Native SW scopes identify document/client URLs, not query strings. */
export function guestScopeMatches(scopeUrl: string, requestUrl: string): boolean {
  try {
    const scope = new URL(scopeUrl);
    const target = new URL(requestUrl);
    if (scope.origin !== target.origin || !/^https?:$/.test(scope.protocol)) return false;
    return target.pathname.startsWith(scope.pathname);
  } catch {
    return false;
  }
}

/** Pure, bounded registry; no execution, fetch, postMessage or privileged
    handles. The owner origin must come from the engine's verified virtual
    context, never a script-supplied site ID. */
export class GuestRegistrationRegistry {
  private readonly byKey = new Map<string, GuestRegistrationIdentity>();
  constructor(private readonly limit = 64) {}

  register(ownerPageUrl: string, scriptURL: string, scope?: string): GuestRegistrationIdentity {
    const rec = canonicalGuestRegistration(ownerPageUrl, scriptURL, scope);
    const key = rec.origin + "\0" + rec.scope;
    if (!this.byKey.has(key) && this.byKey.size >= this.limit)
      throw new RangeError("Guest registration limit reached");
    this.byKey.set(key, rec);
    return { ...rec };
  }

  find(ownerPageUrl: string, clientUrl: string): GuestRegistrationIdentity | null {
    let origin: string;
    try {
      const owner = new URL(ownerPageUrl);
      const client = new URL(clientUrl, owner.href);
      if (!/^https?:$/.test(owner.protocol) || owner.origin !== client.origin) return null;
      origin = owner.origin;
    } catch {
      return null;
    }
    let best: GuestRegistrationIdentity | null = null;
    for (const rec of this.byKey.values()) {
      if (rec.origin !== origin || !guestScopeMatches(rec.scope, new URL(clientUrl, ownerPageUrl).href)) continue;
      if (!best || rec.scope.length > best.scope.length) best = rec;
    }
    return best ? { ...best } : null;
  }

  unregister(ownerPageUrl: string, scopeUrl: string): boolean {
    try {
      const owner = new URL(ownerPageUrl);
      const scope = new URL(scopeUrl);
      if (!/^https?:$/.test(owner.protocol) || owner.origin !== scope.origin ||
          scope.search || scope.hash) return false;
      return this.byKey.delete(owner.origin + "\0" + scope.href);
    } catch {
      return false;
    }
  }

  clear(): void { this.byKey.clear(); }
  count(): number { return this.byKey.size; }
}
