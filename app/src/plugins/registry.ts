/* Build-time static plugin registry (#256). Chromium service workers
   cannot dynamic-import, so every loadable plugin is STATICALLY
   imported here and compiled into the sw bundle by the vite build.
   Adding a plugin: drop a module in app/src/plugins/, export
   register(hooks), add one line to REGISTRY, rebuild. There is no
   runtime loading of any kind: plugin code can never come from an
   unapproved origin, path or fetched text. */

import type { PluginHooks } from "../plugins";
import { register as sampleObserver } from "./sample-observer";

export type PluginRegister = (hooks: PluginHooks) => void;

export const REGISTRY: Record<string, PluginRegister> = {
  "sample-observer": sampleObserver,
};
