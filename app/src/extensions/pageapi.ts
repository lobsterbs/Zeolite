/* Zeolite extension subsystem: extension-origin page API (#40).

   handleExtPageCall answers the zl:extPage RPCs the page bridge
   sends. The SW has already verified the sender is a registered page
   client of this extension (client ids are SW-observed on the granted
   navigation and cannot be forged), so what remains here is the API
   subset: a namespace whitelist, no events, no ports, and a page
   sender for runtime.sendMessage. Everything else walks the
   extension's real API object, so permission mounting stays honest:
   a namespace absent without its permission simply does not resolve. */

import { MESSENGER, getExtensionContext } from "./context";
import type { ExtensionRecord } from "./types";

export const PAGE_APIS = new Set([
  "runtime",
  "storage",
  "cookies",
  "downloads",
  "notifications",
  "contextMenus",
  "menus",
]);

export interface ExtPageCall {
  path?: unknown;
  args?: unknown;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* The dotted call list served to the page bridge in __page.js. Same
   surface handleExtPageCall enforces, computed from the live
   permissions so feature detection on the page answers honestly. */
export function pageCallList(rec: ExtensionRecord): string[] {
  const calls: string[] = ["runtime.getManifest", "runtime.sendMessage"];
  if (rec.permissions.includes("storage")) {
    for (const area of ["local", "sync", "session"]) {
      for (const op of ["get", "set", "remove", "clear", "getBytesInUse"]) {
        calls.push("storage." + area + "." + op);
      }
    }
  }
  if (rec.permissions.includes("cookies")) {
    for (const op of ["get", "getAll", "set", "remove"]) calls.push("cookies." + op);
  }
  for (const op of ["download", "search"]) calls.push("downloads." + op);
  if (rec.permissions.includes("notifications")) {
    for (const op of ["create", "update", "clear", "getAll"]) calls.push("notifications." + op);
  }
  for (const ns of ["contextMenus", "menus"]) {
    for (const op of ["create", "update", "remove", "removeAll"]) calls.push(ns + "." + op);
  }
  return calls;
}

export async function handleExtPageCall(
  rec: ExtensionRecord,
  senderUrl: string | null,
  call: ExtPageCall,
): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  const rawPath = Array.isArray(call.path) ? call.path : null;
  if (!rawPath || rawPath.length === 0 || rawPath.some((s) => typeof s !== "string")) {
    return { ok: false, error: "bad call path" };
  }
  const path = rawPath as string[];
  const args = Array.isArray(call.args) ? call.args : [];
  if (!PAGE_APIS.has(path[0] ?? "")) {
    return { ok: false, error: "api not available to extension pages: " + path[0] };
  }
  for (const seg of path) {
    if (seg.startsWith("on")) {
      return { ok: false, error: "events are not delivered to extension pages" };
    }
    if (seg === "connect") {
      return { ok: false, error: "ports are not supported in extension pages" };
    }
  }
  if (path[0] === "runtime" && path[1] === "sendMessage") {
    try {
      const reply = await MESSENGER.sendMessage(rec.id, {
        extensionId: rec.id,
        context: "extension-page",
        url: senderUrl,
      }, args[0]);
      return { ok: true, response: reply };
    } catch (err) {
      return { ok: false, error: msgOf(err) };
    }
  }
  const ctx = await getExtensionContext(rec);
  let node: unknown = ctx.api.browser;
  for (const seg of path) {
    if (typeof node !== "object" || node === null) {
      return { ok: false, error: "no such api: " + path.join(".") };
    }
    node = (node as Record<string, unknown>)[seg];
  }
  if (typeof node !== "function") {
    return { ok: false, error: "no such api: " + path.join(".") };
  }
  try {
    const response = await (node as (...a: unknown[]) => unknown)(...args);
    return { ok: true, response };
  } catch (err) {
    return { ok: false, error: msgOf(err) };
  }
}
