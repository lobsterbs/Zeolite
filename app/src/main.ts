/* Embed client: the Scramjet-compatible entry point.
   LobsterBrowse loads <engine-origin>/?url=<target> in a tab iframe; the
   page brings up the engine via the adapter (engine.ts), rehydrates any
   persisted per-site toggles, then navigates the frame to the encoded
   route so all subresource fetches are intercepted. */

import { ZeoliteEngine } from "./engine";

const status = document.getElementById("zl-status")!;
const frame = document.getElementById("zl-frame") as HTMLIFrameElement;

const target = new URLSearchParams(location.search).get("url");

if (!target) {
  status.textContent = "Zeolite engine. Append ?url=<target> to embed.";
} else {
  void (async () => {
    status.textContent = "Starting engine...";
    const engine = new ZeoliteEngine();
    try {
      await engine.init();
    } catch (err) {
      status.textContent = "Service worker registration failed: " + String(err);
      return;
    }
    if (!navigator.serviceWorker.controller) {
      // First-ever load on this origin: reload once so the SW controls
      // the page, keeping ?url intact.
      location.reload();
      return;
    }
    // Rehydrate persisted per-site toggles into the fresh SW.
    try {
      const disabled = JSON.parse(localStorage.getItem("zl:disabled-sites") ?? "[]") as string[];
      for (const site of disabled) await engine.setSiteRoute(site, false);
    } catch { /* nothing persisted */ }
    status.style.display = "none";
    frame.style.display = "block";
    /* #55: the frame navigates an opaque route minted by the SW, so
       the destination never appears in a browser-visible URL. */
    frame.src = await engine.navigateOpaque(target);
  })();
}
