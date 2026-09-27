/* Zeolite extension subsystem: per-extension runtime context.

   One context per extension: loaded storage areas and the API object
   pair (browser.* + chrome.*) built for the background sender. The
   messenger is a singleton shared by every extension, but its channels
   are keyed by extension id, so nothing crosses extensions. */

import { buildApi } from "./runtime";
import { ExtensionStorageArea } from "./storage";
import { openDb } from "./idb";
import { ExtensionMessenger } from "./messaging";
import { extensions } from "./manager";
import type { ExtensionId, ExtensionRecord } from "./types";

export const MESSENGER = new ExtensionMessenger();

export interface ExtensionContext {
  storage: {
    local: ExtensionStorageArea;
    sync: ExtensionStorageArea;
    session: ExtensionStorageArea;
  };
  api: { browser: Record<string, unknown>; chrome: Record<string, unknown> };
}

const contexts = new Map<ExtensionId, ExtensionContext>();

export async function getExtensionContext(ext: ExtensionRecord): Promise<ExtensionContext> {
  let ctx = contexts.get(ext.id);
  if (ctx) return ctx;
  const db = await openDb();
  const local = new ExtensionStorageArea(ext.id, "local", "local");
  const sync = new ExtensionStorageArea(ext.id, "sync", "sync");
  const session = new ExtensionStorageArea(ext.id, "session", "session");
  await local.load(db);
  await sync.load(db);
  const sender = { extensionId: ext.id, context: "background" as const, url: null };
  const api = buildApi(ext, sender, {
    messenger: MESSENGER,
    storage: { local, sync, session },
    manager: extensions,
  });
  ctx = { storage: { local, sync, session }, api };
  contexts.set(ext.id, ctx);
  return ctx;
}
