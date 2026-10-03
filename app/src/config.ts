/* Engine configuration. Overridable at build time via Vite defines so a
   deployment is single-config: set ZL_WISP_URL and rebuild. */

const g = globalThis as typeof globalThis & {
  ZL_WISP_URL?: string;
  location?: Location;
};

/** Wisp server WebSocket endpoint for this deployment. */
export const ZL_WISP_URL: string =
  g.ZL_WISP_URL ??
  ((g.location?.protocol === "https:" ? "wss://" : "ws://") +
    (g.location?.host ?? "localhost:6002") +
    "/wisp/");

/* Issue #53: opt-in engine-side HTTPS upgrade. The SW applies this
   at the single destination choke point (and per redirect hop), so
   the engine never fetches cleartext while it is on; a failed
   upgrade surfaces through the normal error pipeline, never a
   silent fallback. Pure and unit-tested; the live toggle lives in
   the SW, persisted with the route shape and set through
   zl:config. */
export function httpsUpgraded(dest: string, enabled: boolean): string {
  return enabled && dest.startsWith("http://")
    ? "https://" + dest.slice("http://".length)
    : dest;
}
