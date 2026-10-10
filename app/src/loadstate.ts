/// <reference lib="webworker" />
/* In-flight upstream request accounting for the embedder's loading
   indicator. The host asked for: the tab spinner must be on while
   anything for the site is still loading, off only when every
   loading task settled. The transport seam (transport.ts
   wispFetch) is the one place every upstream request passes
   through, so the counter rides it: a request counts from its
   first upstream attempt until its headers arrive (TTFB
   semantics) or it fails honestly. Rewritten document bodies pump
   past TTFB; those streams are counted separately (streams-alive)
   and reported alongside by the zl:loadState reply. Grouped by
   destination host so the embedder can attribute work to a tab;
   the global count is the sum of the groups. Host-only control
   surface: a proxied page must not enumerate other sites'
   loading activity. */
let byHost: Map<string, number> = new Map();

function hostOf(dest: string): string {
  try {
    return new URL(dest).host;
  } catch {
    /* not an absolute URL: nothing to attribute */
    return "";
  }
}

/** An upstream request started (its headers have not arrived yet). */
export function loadEnter(dest: string): void {
  const host = hostOf(dest);
  if (!host) return;
  byHost.set(host, (byHost.get(host) ?? 0) + 1);
}

/** An upstream request settled (headers arrived, or it failed). */
export function loadLeave(dest: string): void {
  const host = hostOf(dest);
  if (!host) return;
  const next = (byHost.get(host) ?? 1) - 1;
  if (next > 0) byHost.set(host, next);
  else byHost.delete(host);
}

/** In-flight count for one destination host, or the global sum
    when no host is given. Garbage never counts; the count never
    goes negative (leave without enter is a no-op). */
export function loadInflight(host?: string): number {
  if (host) return byHost.get(host) ?? 0;
  let total = 0;
  for (const n of byHost.values()) total += n;
  return total;
}

/** Test seam: drop all accounting. */
export function loadResetForTests(): void {
  byHost = new Map();
}