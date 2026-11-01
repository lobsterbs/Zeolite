/* Zeolite bootstrap: on-demand loader for the finder (#29) and the
   Tier 2 DOM inspection bridge (#550).

   The full in-page finder is far larger than the bootstrap budget,
   so the engine ships it to the page at first use: the service
   worker attaches the compiled finder source (the finder.js sibling
   artifact of sw.js) to every zl:findLoad message. This loader
   evaluates it once per document (idempotent, __zlFind guard) and
   hands it the message that carried the code and every later one.

   Same trust boundary as every page-targeted engine message: only
   the controlling service worker is accepted; the finder checks
   the destination itself. A page CSP that blocks eval refuses the
   code: no find, honestly. */

export function applyFindLoad(w: Record<string, unknown>): void {
  const nav = w.navigator as
    | {
        serviceWorker?: {
          controller?: unknown;
          addEventListener: (t: string, f: (ev: MessageEvent) => void) => void;
        };
      }
    | undefined;
  const sw = nav && nav.serviceWorker;
  const ctl = sw && sw.controller;
  if (!sw || !ctl) return;
  sw.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== ctl) return;
    const m = ev.data as { type?: string; code?: string };
    if (!m) return;
    /* #550: the domInspect bundle ships the same way, attached to the
       authorize ctl message. It registers its own listener for the
       messages that follow, so the handover only happens for the
       carrying event, exactly once, right after the eval. */
    const inspect = m.type === "zl:domInspectCtl" && typeof m.code === "string";
    if (!inspect && m.type !== "zl:findLoad") return;
    const g = inspect ? "__zlDomInspect" : "__zlFind";
    let fresh = false;
    try {
      if (typeof w[g] !== "function") {
        (w.eval as (s: string) => unknown)(m.code ?? "");
        fresh = true;
      }
    } catch { /* hostile or restricted page context: stays without the feature */ }
    const h = w[g] as ((ev: MessageEvent) => void) | undefined;
    /* The inspector registered its own listener at eval, so every
       event but the carrying one already reached it; the finder does
       not self-register and needs the handover on every message. */
    if (inspect && !fresh) return;
    if (typeof h === "function") {
      try {
        h(ev);
      } catch { /* a bridge crash must not kill the page; the SW
                    timeout answers the command honestly */ }
    }
  });
}
