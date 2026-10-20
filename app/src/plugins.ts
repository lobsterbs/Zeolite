/* Plugin API contract (Phase 4), #256: service-worker-safe loading
   through the build-time static registry (./plugins/registry.ts).
   Chromium does not support dynamic import() in the targeted service
   worker, so plugins are compiled into the bundle via static imports.
   A configured name that is not in the registry fails safely to null
   with ONE bounded diagnostic per name per worker lifetime; no code
   is fetched or evaluated at runtime. */

import { DIAG } from "./diag";
import { REGISTRY } from "./plugins/registry";

/* A plugin module exports a register(hooks) function:

     export function register(hooks) {
       hooks.onRequest({ url, headers })  -> { headers } | void
       hooks.onResponse({ url, status, headers }) -> void
     }

   Hooks may not block or rewrite the body: they observe and adjust
   headers only. register(hooks) runs once per plugin per worker
   lifetime; the resolved hook set is memoized. */

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

/** Siteconfig plugin names use a narrow identifier grammar. */
export function pluginNameOk(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

const hooksByName = new Map<string, PluginHooks | null>();
const warnedUnknown = new Set<string>();

/** Resolve a plugin name to its hook set through the static registry
    (#256). Unknown or invalid names fail safely to null; unknown
    names emit one bounded UNSUPPORTED warning each. register() errors
    are isolated: the plugin degrades to null and never breaks the
    request path. */
export function loadPlugin(name: string): Promise<PluginHooks | null> {
  if (!pluginNameOk(name)) return Promise.resolve(null);
  if (hooksByName.has(name)) return Promise.resolve(hooksByName.get(name) ?? null);
  let hooks: PluginHooks | null = null;
  const register = REGISTRY[name];
  if (register) {
    const h: PluginHooks = {};
    try {
      register(h);
      hooks = h;
    } catch (err) {
      DIAG.emit({
        category: "RUNTIME",
        cause: "failure",
        severity: "warning",
        message: "plugin failed to register: " + name,
        technicalReason: String(err),
      });
      hooks = null;
    }
  } else if (!warnedUnknown.has(name)) {
    warnedUnknown.add(name);
    DIAG.emit({
      category: "UNSUPPORTED",
      cause: "unsupported",
      severity: "warning",
      message: "site plugin is not in the build registry: " + name,
    });
  }
  hooksByName.set(name, hooks);
  return Promise.resolve(hooks);
}

/** Resolve the plugin list for a site rule into hook sets. */
async function hooksFor(names: string[] | undefined): Promise<PluginHooks[]> {
  if (!names?.length) return [];
  const hooks = await Promise.all(names.map(loadPlugin));
  return hooks.filter((h): h is PluginHooks => h !== null);
}

/** Apply every plugin's onRequest hook; last write wins per header.
    Awaited by the request engine before the upstream send: a returned
    header map replaces the outgoing set for that request. */
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

/** Fire every plugin's onResponse hook. Contract (#256): onResponse
    hooks are BEST-EFFORT OBSERVERS. They run synchronously on the
    response path, header edits are ignored, and a throwing hook is
    isolated inside this function - the request engine fires them
    without awaiting (request.ts) precisely because they cannot
    affect the response, and they can never delay it indefinitely. */
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
