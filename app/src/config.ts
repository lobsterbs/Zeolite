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

/* Runtime primary wisp endpoint chosen by the embedder (LobsterBrowse
   Settings > WISP servers). null means the build-time ZL_WISP_URL. */
let primaryWispOverride: string | null = null;

/** Normalized ws(s):// endpoint, or null for "" and for anything that
    is not a parseable ws:// or wss:// URL. Never throws. */
export function normalizeWispUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const t = url.trim();
  if (!t.startsWith("ws://") && !t.startsWith("wss://")) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** The primary wisp endpoint in use right now. */
export function primaryWispUrl(): string {
  return primaryWispOverride ?? ZL_WISP_URL;
}

/** The runtime override, or null when the build-time endpoint is in use. */
export function primaryWispOverrideValue(): string | null {
  return primaryWispOverride;
}

/** State-only setter (no transport side effects). transport.ts owns
    the reset that makes the change take effect. */
export function setPrimaryWispOverride(url: string | null): void {
  primaryWispOverride = url;
}

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
