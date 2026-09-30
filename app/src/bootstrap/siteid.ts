/* Page identity helpers shared by the bootstrap modules: the site
   storage hash, the virtual page origin and the controller lookup,
   stated once so the minified bundle pays for them once. */

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* The page origin ("" when unparseable): the storage prefix derives
   from it and the cookie / serviceWorker shims share it. */
export function pageOrigin(dest: string): string {
  try {
    return new URL(dest).origin;
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
