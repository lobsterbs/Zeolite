/* Runtime eval virtualization (#726, the #725 residual).

   window.location is LegacyUnforgeable, so no runtime hook can
   change what the native location reads return; the rewriter
   renames location reads in served JS to __zl, but a program that
   arrives as a string and is eval'd at runtime (BotGuard's VM,
   eval'd into the adopted /_/bscframe realm) never passes the
   rewriter - its bare location reads kept the committed engine
   origin and the minted attestation named the wrong origin.

   This shim closes that lane for sites that opted into virtual
   origin reporting (#725: __ZL.locationOrigin === "virtual"): it
   replaces the realm's own eval with a Proxy over the native eval
   that pipes string sources through the page-side globals renamer
   (window.__zlRG, published by evalrw.js) before the native eval
   runs them. Non-strings pass through; before the renamer lands,
   on any renamer error, and on every non-gated site the call is
   byte-identical to native eval (fail-closed).

   Honest limits, deliberate:
   - direct eval in the gated page degrades to indirect eval (the
     callee is no longer the %eval% intrinsic), so var hoisting
     lands on the realm global; gated sites only, and BotGuard's
     call is contentWindow.eval, already indirect.
   - new Function and Worker code stay native (documented
     residual, same as before this shim).
   - the Proxy stringifies native-looking: Function.prototype.toString
     on a callable Proxy is spec-mandated to "function () { [native code] }",
     so a toString probe sees native shape, and property reads (name)
     forward to the native callee. */

export function applyEvalShim(
  w: Record<string, unknown>,
  originMode?: "virtual" | "native",
  load: (u: string) => Promise<unknown> = (u) => import(u),
): void {
  if (originMode !== "virtual") return; /* site gate: #725 opt-in only */
  if (w.__zlEvalShim) return; /* once per realm */
  const nat = w.eval;
  if (typeof nat !== "function") return;
  /* The asset base: emit_injections gives the bootstrap an
     engine-origin-absolute src, so the sibling module URL derives
     from the running script's own src. No currentScript (async
     load, a sealed realm): stay fully native. */
  let src = "";
  try {
    const cs = (w.document as { currentScript?: { src?: string } } | undefined)?.currentScript;
    if (cs && typeof cs.src === "string" && cs.src !== "") src = cs.src;
  } catch {
    return;
  }
  if (!src) return;
  try {
    load(new URL("evalrw.js", src).href).catch(() => {});
  } catch {
    return; /* no dynamic import in the realm: stay native */
  }
  const wrapped = new Proxy(nat, {
    apply(target: typeof nat, _thisArg: unknown, args: unknown[]) {
      const rg = w.__zlRG as ((js: string) => string) | undefined;
      const s = args[0];
      if (typeof s !== "string" || typeof rg !== "function") {
        return Reflect.apply(target, w, args);
      }
      try {
        return Reflect.apply(target, w, [rg(s), ...args.slice(1)]);
      } catch {
        return Reflect.apply(target, w, args); /* fail closed */
      }
    },
  });
  w.__zlEvalShim = true;
  try {
    w.eval = wrapped;
  } catch {
    /* a non-writable realm global keeps native eval */
    w.__zlEvalShim = false;
  }
}

