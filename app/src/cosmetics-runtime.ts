/* Compiled page artifact entry (#551, second slice). The engine
   splices the minified body of this bundle inline into proxied
   documents that pass the cosmetic gates, immediately followed by
   one __zlCosmeticRun(payload) call carrying the allowlisted
   scriptlet invocations. The page core never imports
   service-worker modules: this artifact must stay tiny (CI pins a
   byte budget) and must not drag the engine graph into the page. */

import { applyCosmeticPage } from "./cosmetic-page";

const G = globalThis as unknown as Record<string, unknown>;
if (typeof G.__zlCosmeticRun !== "function") {
  G.__zlCosmeticRun = (payload: unknown): void => {
    applyCosmeticPage(G, payload);
  };
}
