/* Embed client: the Scramjet-compatible entry point.
   LobsterBrowse loads <engine-origin>/?url=<target> in a tab iframe; the
   page brings up the engine via the adapter (engine.ts), rehydrates any
   persisted per-site toggles, then navigates the frame to the encoded
   route so all subresource fetches are intercepted. */

import { ZeoliteEngine } from "./engine";

const status = document.getElementById("zl-status")!;
const frame = document.getElementById("zl-frame") as HTMLIFrameElement;

const target = new URLSearchParams(location.search).get("url");

/* #121 refresh-spam rule: a first-ever load on this origin has no
   controller yet, so the page must reload ONCE for the SW to take
   control. The boot key in sessionStorage caps that at one attempt
   per tab session: a worker that never claims shows a status message
   instead of looping reloads. Without storage (sandboxed frame) no
   guard can hold, so no reload is attempted at all. */
const BOOT_KEY = "zl:boot-reload";

if (!target) {
  status.textContent = "Zeolite engine. Append ?url=<target> to embed.";
} else {
  void (async () => {
    status.textContent = "Starting engine...";
    const engine = new ZeoliteEngine();
    let controlled = false;
    try {
      controlled = await engine.init();
    } catch (err) {
      status.textContent = "Service worker registration failed: " + String(err);
      return;
    }
    if (!controlled) {
      let store: Storage | null = null;
      try {
        store = sessionStorage;
      } catch {
        /* sandboxed: the guard could not hold across a reload */
      }
      if (!store) {
        status.textContent =
          "This page cannot be controlled in this context. Open it in a normal tab.";
        return;
      }
      if (store.getItem(BOOT_KEY) === "1") {
        status.textContent =
          "The engine could not take control of this page. Reload to retry.";
        return;
      }
      store.setItem(BOOT_KEY, "1");
      // Reload once so the SW controls the page, keeping ?url intact.
      location.reload();
      return;
    }
    try {
      sessionStorage.removeItem(BOOT_KEY);
    } catch {
      /* sandboxed: the boot key was never set */
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
