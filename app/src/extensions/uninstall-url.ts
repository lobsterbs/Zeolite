/* Zeolite extension subsystem: the per-extension uninstall URL (#518).

   Firefox and Chrome open the stored URL when the browser uninstalls
   the extension; this engine uninstalls through the management path
   (manager.uninstall), so the URL is delivered there - through the
   real tabs bridge, as the uninstall runs. Nothing stored, nothing
   opens. Only http(s) URLs are accepted (Chrome's documented gate);
   calling without a URL clears the stored one, exactly like Firefox's
   setUninstallURL(). */

import type { ExtensionId } from "./types";

const urls = new Map<ExtensionId, string>();

export function setUninstallUrlOf(id: ExtensionId, url: unknown): void {
  if (url === undefined || url === null || url === "") {
    urls.delete(id);
    return;
  }
  if (typeof url !== "string") {
    throw new Error("zeolite: runtime.setUninstallURL: url must be a string");
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("zeolite: runtime.setUninstallURL: url must be an absolute URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("zeolite: runtime.setUninstallURL: only http(s) URLs are supported");
  }
  urls.set(id, url);
}

export function uninstallUrlOf(id: ExtensionId): string | null {
  return urls.get(id) ?? null;
}

export function dropUninstallUrl(id: ExtensionId): void {
  urls.delete(id);
}
