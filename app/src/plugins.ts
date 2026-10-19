/* Plugin API contract (Phase 4). Plugin loading is currently disabled
   in the service worker because Chromium does not support the dynamic
   module import this API previously relied on. See docs/plugins.md.
   Keep the hook types here for the planned static-registry loader. */

import { DIAG } from "./diag";

/* A plugin would default-export (or named-export) a register(hooks)
   function:

     export function register(hooks) {
       hooks.onRequest({ url, headers })  -> { headers } | void
       hooks.onResponse({ url, status, headers }) -> void
     }

   Hooks may not block or rewrite the body: they observe and adjust
   headers only. */

export interface RequestCtx {
  /** Real destination URL. */
  url: string;
  /** Mutable header map (applied only if returned). */
  headers: Record<string, string>;
}

export interface ResponseCtx {
  url: string;
  status: number;
  headers: Record<string, string>;
}

export interface PluginHooks {
  onRequest?: (ctx: RequestCtx) => { headers?: Record<string, string> } | void;
  onResponse?: (ctx: ResponseCtx) => void;
}

let unsupportedWarningSent = false;

/** Siteconfig plugin names use a narrow identifier grammar. */
export function pluginNameOk(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Dynamic module imports are not supported in the Chromium service
    worker runtime Zeolite targets. Until a reviewed static registry is
    shipped, configured plugin names are refused explicitly instead of
    attempting a runtime import that always fails. */
export function loadPlugin(name: string): Promise<PluginHooks | null> {
  if (!pluginNameOk(name)) return Promise.resolve(null);
  if (!unsupportedWarningSent) {
    unsupportedWarningSent = true;
    DIAG.emit({
      category: "UNSUPPORTED",
      cause: "unsupported",
      severity: "warning",
      message: "site plugins are configured, but service-worker plugin loading is unavailable",
    });
  }
  return Promise.resolve(null);
}

/** Resolve the plugin list for a site rule into hook sets. */
async function hooksFor(names: string[] | undefined): Promise<PluginHooks[]> {
  if (!names?.length) return [];
  const hooks = await Promise.all(names.map(loadPlugin));
  return hooks.filter((h): h is PluginHooks => h !== null);
}

/** Apply every plugin's onRequest hook; last write wins per header. */
export async function applyOnRequest(
  names: string[] | undefined,
  url: string,
  headers: Headers,
): Promise<void> {
  const all = await hooksFor(names);
  for (const h of all) {
    if (!h.onRequest) continue;
    try {
      const flat: Record<string, string> = {};
      headers.forEach((v, k) => (flat[k] = v));
      const out = h.onRequest({ url, headers: flat });
      if (out?.headers) {
        for (const [k, v] of Object.entries(out.headers)) headers.set(k, v);
      }
    } catch { /* plugin errors are non-fatal */ }
  }
}

/** Fire every plugin's onResponse hook. */
export async function applyOnResponse(
  names: string[] | undefined,
  url: string,
  status: number,
  headers: Headers,
): Promise<void> {
  const all = await hooksFor(names);
  if (!all.length) return;
  const flat: Record<string, string> = {};
  headers.forEach((v, k) => (flat[k] = v));
  for (const h of all) {
    if (!h.onResponse) continue;
    try {
      h.onResponse({ url, status, headers: flat });
    } catch { /* plugin errors are non-fatal */ }
  }
}
