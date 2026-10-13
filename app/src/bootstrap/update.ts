/* Engine-update notice (#121, refresh-spam rule). The engine's
   worker broadcasts zl:engineUpdate once it activates; a proxied
   page keeps its stale rewritten DOM until the user reloads. The
   bootstrap NEVER reloads on its own: nothing navigates or reloads
   without a user click. Instead it logs one console note per engine
   sha and re-dispatches the update as a window CustomEvent
   (zl:engineUpdate) so the embedding host can surface a manual
   "reload to pick up the new engine" affordance. The guard rides
   the storage patch's sessionStorage (site-scoped): one notice per
   site per version, never a loop. Message events on the container
   stay real through the serviceWorker shim (controller and events
   are documented as untouched), so this listener works in proxied
   pages. */

export function applyUpdateNotice(w: Record<string, unknown>): void {
  const nav = w.navigator as
    | { serviceWorker?: { addEventListener?: (t: string, f: (ev: MessageEvent) => void) => void } }
    | undefined;
  const ns = nav && nav.serviceWorker;
  if (!ns || typeof ns.addEventListener !== "function") return;
  /* Page-lifetime sha guard: a storage-less frame (the catch below)
     has no zlUpd dedupe, so a re-broadcast of the same sha would
     re-fire the notice on every message. */
  let lastSha: string | null = null;
  ns.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: unknown; sha?: unknown; version?: unknown } | null;
    if (!d || d.type !== "zl:engineUpdate" || typeof d.sha !== "string") return;
    if (d.sha === lastSha) return;
    lastSha = d.sha;
    try {
      const ss = w.sessionStorage as Storage;
      if (ss.getItem("zlUpd") === d.sha) return;
      ss.setItem("zlUpd", d.sha);
    } catch {
      /* storage unavailable (sandboxed frame): notify once per sha
         (lastSha above), never per message */
    }
    const con = w.console as { info?: (m: string) => void } | undefined;
    if (con && typeof con.info === "function") {
      con.info("[zeolite] engine updated (" + d.sha + "); reload the page to pick it up");
    }
    try {
      const de = (w as unknown as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent;
      if (typeof de === "function") {
        de(new CustomEvent("zl:engineUpdate", { detail: { sha: d.sha, version: d.version } }));
      }
    } catch {
      /* CustomEvent unavailable: the console note above still fired */
    }
  });
}
