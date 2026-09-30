/* Zeolite bootstrap: on-demand finder loader (#29).

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
    if (!m || m.type !== "zl:findLoad") return;
    try {
      if (typeof w.__zlFind !== "function") {
        (w.eval as (s: string) => unknown)(m.code ?? "");
      }
    } catch { /* hostile or restricted page context: stays without find */ }
    const h = w.__zlFind as ((ev: MessageEvent) => void) | undefined;
    if (typeof h === "function") {
      try {
        h(ev);
      } catch { /* a finder crash must not kill the page; the SW
                    timeout answers the find command honestly */ }
    }
  });
}
