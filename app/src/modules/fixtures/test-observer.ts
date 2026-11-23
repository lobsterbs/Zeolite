/* Test-only module fixture (#542): a signed observer whose register
   exercises the handed hook set. Compiled only when tests add it to the
   registry map; never registered in production site configs. */
import type { PluginHooks } from "../../plugins";

export const seen: { urls: string[]; statuses: number[] } = { urls: [], statuses: [] };

export function register(hooks: PluginHooks): void {
  hooks.onRequest = ({ url, headers }) => {
    seen.urls.push(url);
    void headers;
    return { headers: { "x-mod-observer": "one" } };
  };
  hooks.onResponse = ({ status }) => {
    seen.statuses.push(status);
  };
}
