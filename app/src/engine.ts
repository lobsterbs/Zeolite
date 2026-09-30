/* Zeolite engine adapter (Phase 2). The documented interface
   LobsterBrowse (or any host) programs the engine with. See
   docs/engine-adapter.md for the contract and the embed-URL fallback.

   Design points:
   - init(): registers the SW on the engine origin, waits for control,
     then pushes config (route prefix) to it; the scheme is fixed
     "b64u" since #32 (mirror removed; see docs/engine-adapter.md).
   - navigate(): pure function over the codec; returns the engine-local
     route for a destination.
   - setSiteRoute(): per-site interception toggle, acknowledged by the SW.
   - teardown(): SW unregisters and caches drop; nothing survives an
     engine switch. */

import { encodeDest, setScheme } from "./codec";

export interface EngineConfig {
  /** Wisp endpoint; defaults to wss(s)://<engine-origin>/wisp/. */
  wispUrl?: string;
  /** Route scheme. Fixed "b64u" since #32 (mirror removed); kept in
      the config type for adapter compatibility - the SW rejects any
      other value. */
  pathScheme?: "b64u";
  /** Path prefix for the b64u scheme. Default "/j/". */
  pathPrefix?: string;
  /** Cookie jar profile: multiple accounts per site. Default "default". */
  profile?: string;
}

export class ZeoliteEngine {
  private config: Required<Pick<EngineConfig, "pathScheme" | "pathPrefix" | "profile">> & EngineConfig = {
    pathScheme: "b64u",
    pathPrefix: "/j/",
    profile: "default",
  };

  /** Register the SW, wait for control, push config. Idempotent. */
  async init(config: EngineConfig = {}): Promise<void> {
    this.config = { ...this.config, ...config };
    /* Scheme is fixed "b64u" since #32; only the prefix is
       configurable (pathScheme stays in the config type for adapter
       compatibility). */
    setScheme(this.config.pathPrefix);

    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    let tries = 0;
    while (!navigator.serviceWorker.controller && tries++ < 50) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!navigator.serviceWorker.controller) {
      // First-ever load on this origin: SW claims on the next navigation.
      // The host should reload once; init() will then fully succeed.
      return;
    }
    await this.post({ type: "zl:config", prefix: this.config.pathPrefix });
  }

  /** Engine-local route for a destination (usable as an iframe src). */
  navigate(target: string): string {
    return encodeDest(target);
  }

  /** Enable/disable interception for one site. */
  async setSiteRoute(site: string, enabled: boolean): Promise<void> {
    await this.post({ type: "zl:siteRoute", site, enabled });
    // Persist across SW restarts (the SW is ephemeral; the adapter is
    // the durable brain).
    const key = "zl:disabled-sites";
    const cur = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    if (enabled) cur.delete(site);
    else cur.add(site);
    localStorage.setItem(key, JSON.stringify([...cur]));
  }

  /** Uninstall: SW unregisters, caches drop, no state survives. */
  async teardown(): Promise<void> {
    const ctl = navigator.serviceWorker.controller;
    if (ctl) {
      await new Promise<void>((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ctl.postMessage({ type: "zl:teardown" }, [ch.port2]);
        // Unregister is idempotent; resolve even if the reply never comes.
        setTimeout(resolve, 3000);
      });
    }
    localStorage.removeItem("zl:origins");
    localStorage.removeItem("zl:disabled-sites");
  }

  /** PostMessage with a reply port; resolves on acknowledgement. */
  private post(msg: unknown): Promise<{ ok: boolean; error?: string }> {
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return Promise.resolve({ ok: false, error: "no controller" });
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data as { ok: boolean; error?: string });
      ctl.postMessage(msg, [ch.port2]);
      setTimeout(() => resolve({ ok: false, error: "timeout" }), 5000);
    });
  }
}

export type { ZeoliteEngine as default };

