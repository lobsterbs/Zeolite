/* Engine-update reload (#121). The engine's worker broadcasts
   zl:engineUpdate once it activates; a proxied page keeps its stale
   rewritten DOM until it reloads, so the bootstrap reloads once per
   engine sha. The guard rides the storage patch's sessionStorage
   (site-scoped): one reload per site per version, never a loop.
   Message events on the container stay real through the
   serviceWorker shim (controller and events are documented as
   untouched), so this listener works in proxied pages. */

export function applyUpdateReload(w: Record<string, unknown>): void {
  const nav = w.navigator as
    | { serviceWorker?: { addEventListener?: (t: string, f: (ev: MessageEvent) => void) => void } }
    | undefined;
  const ns = nav && nav.serviceWorker;
  if (!ns || typeof ns.addEventListener !== "function") return;
  ns.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: unknown; sha?: unknown } | null;
    if (!d || d.type !== "zl:engineUpdate" || typeof d.sha !== "string") return;
    try {
      const ss = w.sessionStorage as Storage;
      if (ss.getItem("zlUpd") === d.sha) return;
      ss.setItem("zlUpd", d.sha);
    } catch {
      /* storage unavailable (sandboxed frame): reload anyway */
    }
    (w.location as Location).reload();
  });
}
