/* Page-side globals renamer for the runtime eval shim (#726).

   The #725 wave left bare location reads in runtime-eval'd strings
   native: a program that arrives as a string and is eval'd into a
   proxied realm never passes the rewriter, so its location reads
   kept the committed engine origin. This module is the lazy
   page-side half: the bootstrap's eval shim imports it from the
   engine asset base when a site opted into virtual origin
   reporting (#725); it initializes the SAME wasm rewriter the
   worker uses (the sibling-fetched rewriter_wasm_bg.wasm) and
   publishes window.__zlRG, a fail-closed single-argument renamer.

   Deliberately no other surface: URL literals stay untouched (the
   page realm must never mint keyed routes - an unkeyed route is
   refused fail-closed at decode and would break the eval'd
   program's fetches), so this exposes the globals pass only, the
   exact location-read renames a served script body gets. */
import init, { rewriteGlobals } from "./rewriter_wasm/rewriter_wasm.js";

init().then(
  () => {
    (self as unknown as Record<string, unknown>).__zlRG = (js: string): string => {
      try {
        return rewriteGlobals(js);
      } catch {
        return js; /* fail closed: the program runs native */
      }
    };
  },
  () => {
    /* init failure leaves __zlRG unset: the shim stays passthrough */
  },
);

