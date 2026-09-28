/* Module-worker import specifier routing (Phase 13, 2.3 Selenide).

   Classic workers get importScripts routing in the prelude. Module
   workers cannot be patched that way: static import specifiers are
   resolved before the prelude (or any module code) runs, and import()
   is host syntax, not a patchable global. The service worker therefore
   rewrites import/export-from specifiers in the module worker body at
   serve time:

   - absolute http(s) specifiers become engine routes (otherwise they
     escape the engine as cross-origin requests that fail),
   - relative specifiers become engine routes too (they would resolve
     against the engine route and be recovered via the request
     referrer, but routing them here keeps every specifier one hop and
     consistent with the classic-worker story),
   - bare specifiers (node-style package names) pass through: without
     a resolver there is nothing honest to map them to (same
     documented limit as pages),
   - opaque (data:/blob:), engine-local and already-encoded engine
     routes pass through untouched (the decode-side unwrap peels any
     stale binding).

   Honest limit: this is a text pass, not a JS parser, so a specifier
   pattern inside an ordinary string literal is rewritten as well.
   The body is buffered for the pass (worker scripts are not
   first-paint documents); classic workers keep their streaming path. */

import { encodeDest, isEnginePath, setScheme } from "./codec";

const SPEC_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+[^;'"]*?\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;

/** True for specifiers the pass must not touch. */
function passthrough(abs: URL, engineOrigin: string): boolean {
  if (abs.origin === engineOrigin) return true; // engine-local
  if (abs.protocol !== "http:" && abs.protocol !== "https:") return true; // opaque
  return false;
}

/** Route one module specifier into an engine route, or return it
    unchanged. Exported for tests. */
export function routeModuleSpecifier(
  prefix: string,
  workerUrl: string,
  engineOrigin: string,
  spec: string,
): string {
  /* Bare specifier: no scheme, not root- or dot-relative. */
  if (!/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("/") && !spec.startsWith(".")) {
    return spec;
  }
  let abs: URL;
  try {
    abs = new URL(spec, workerUrl);
  } catch {
    return spec;
  }
  if (passthrough(abs, engineOrigin)) return spec;
  if (isEnginePath(abs.pathname)) return spec; // already a route: decode peels
  setScheme(prefix);
  return encodeDest(abs.href);
}

/** Rewrite every import/export specifier in a module worker body.
    Pure: same input, same output. */
export function rewriteModuleWorkerImports(
  prefix: string,
  workerUrl: string,
  engineOrigin: string,
  src: string,
): string {
  return src.replace(SPEC_RE, (m, head: string, q: string, spec: string) => {
    const out = routeModuleSpecifier(prefix, workerUrl, engineOrigin, spec);
    return out === spec ? m : head + q + out + q;
  });
}
