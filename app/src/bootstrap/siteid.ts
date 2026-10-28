/* Page identity helpers shared by the bootstrap modules: the site

   storage hash, the virtual page origin and the controller lookup,
   stated once so the minified bundle pays for them once. */
import { NativeURL } from "./anchorshim";

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    /* #270: Math.imul is the real 32-bit FNV multiply. The old
       h * 0x01000193 in double precision loses low bits past 2^53
       inputs and produced an actual collision: two distinct origins
       hashed to the same token (sgb2js). */
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* The page origin ("" when unparseable): the storage prefix derives
   from it and the cookie / serviceWorker shims share it. */
export function pageOrigin(dest: string): string {
  try {
    return new NativeURL(dest).origin;
  } catch {
    return "";
  }
}

/* One controller lookup for the SW seams (cookie jar, relay, ws
   bridge): the transpiled optional chain is the minified bundle's
   most expensive idiom, a shared helper keeps the size gate fed. */
export function swc(): ServiceWorker | undefined {
  const sw = (navigator as { serviceWorker?: { controller?: ServiceWorker } })
    .serviceWorker;
  return sw && sw.controller;
}

