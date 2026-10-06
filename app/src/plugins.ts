/* Plugin API (Phase 4). A plugin is an ES module served at
   /plugins/<name>.js on the engine origin and listed in a site's
   "plugins" rule in siteconfig.json. It default-exports (or named
   -exports) a register(hooks) function:

     export function register(hooks) {
       hooks.onRequest({ url, headers })  -> { headers } | void
       hooks.onResponse({ url, status, headers }) -> void
     }

   Hooks may not block or rewrite the body: they observe and adjust
   headers only. Failures in a plugin are logged and never break the
   request path (a broken plugin degrades to a no-op). See
   docs/plugins.md for the full contract. */

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

interface PluginModule {
  register?: (hooks: PluginHooks) => void;
  default?: { register?: (hooks: PluginHooks) => void };
}

const loaded = new Map<string, Promise<PluginHooks | null>>();

/** #97: the name is interpolated into a dynamic import that
    @vite-ignore exempts from static analysis, and it arrives from
    siteconfig rules (untrusted-shaped input). Anything outside
    [A-Za-z0-9_-] is refused before the import is ever attempted, so
    traversal ("../") and absolute-URL names cannot smuggle a
    cross-origin or off-root module in. Exported for tests. */
export function pluginNameOk(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Load one plugin module by name. Successful loads are memoized;
    a failed load is dropped from the cache (#97: a transient import
    failure used to be memoized as a sticky null until the whole
    worker restarted, so a plugin that failed once never came back). */
export function loadPlugin(name: string): Promise<PluginHooks | null> {
  if (!pluginNameOk(name)) return Promise.resolve(null);
  let p = loaded.get(name);
  if (!p) {
    p = (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ `/plugins/${name}.js`)) as PluginModule;
        const hooks: PluginHooks = {};
        const reg = mod.register ?? mod.default?.register;
        if (typeof reg === "function") reg(hooks);
        return hooks;
      } catch {
        // Missing or broken plugin: no-op, never break a request.
        return null;
      }
    })();
    loaded.set(name, p);
    // Only a successful load is sticky; drop a failure so the next
    // call retries the import instead of caching the null forever.
    void p.then((hooks) => {
      if (hooks === null) loaded.delete(name);
    });
  }
  return p;
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
