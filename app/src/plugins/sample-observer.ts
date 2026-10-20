/* Sample plugin (#256): a minimal, side-effect-free demonstration of
   the hook contract. It observes responses for any site rule that
   lists it and emits ONE diagnostic on the first response it sees, so
   a configured rule proves the registry loader end to end (visible in
   the Diagnostics panel) without changing any traffic. */

import type { PluginHooks } from "../plugins";
import { DIAG } from "../diag";

let seen = false;

export function register(hooks: PluginHooks): void {
  hooks.onResponse = ({ url, status }) => {
    if (seen) return;
    seen = true;
    DIAG.emit({
      category: "RUNTIME",
      severity: "info",
      message: "sample-observer plugin loaded and saw a response: " + status + " " + url,
    });
  };
}
