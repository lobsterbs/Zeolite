/* Per-site storage scoping: everything is prefixed by a short stable
   hash of the site origin, so engine-origin storage is never touched
   by a proxied site and two proxied sites never see each other's
   data. Split out of the bootstrap entry; the bodies are unchanged,
   they take the page global and the site prefix as parameters. */

export function applyStorage(w: Record<string, unknown>, P: string): void {
  const pre = (n: string) => P + n;
/* One scanner for clear/key/length: keeps the scoped Storage cheap
 and the minified bootstrap inside its CI size budget. */
function siteKeys(store: Storage): string[] {
 const ks: string[] = [];
 for (let i = 0; i < store.length; i++) {
 const k = store.key(i);
 if (k && k.startsWith(P)) ks.push(k);
 }
 return ks;
}

{
 for (const name of ["localStorage", "sessionStorage"] as const) {
 const LS = w[name] as Storage | undefined;
 if (!LS) continue;
 const scoped = {
 getItem: (k: string) => LS.getItem(pre(k)),
 setItem: (k: string, v: string) => LS.setItem(pre(k), v),
 removeItem: (k: string) => LS.removeItem(pre(k)),
 clear: () => {
 siteKeys(LS).forEach((k) => LS.removeItem(k));
 },
 key: (i: number) => siteKeys(LS)[i] ?? null,
 get length() {
 return siteKeys(LS).length;
 },
 } as Storage;
 try {
 Object.defineProperty(w, name, { value: scoped, configurable: true });
 } catch { /* read-only context: storage then stays unscoped */ }
 }
}

/* ---- IndexedDB + Cache API names ---------------------------------- */
/* 1.5 Silicide: DB and cache names get the same site prefix, so two
 proxied sites never share a database or a cache, and neither ever
 touches an engine-own one (the engine's IndexedDB and Cache usage
 lives in the service worker, not the page). */
/* #35 (browser E2E): the shims install via Object.defineProperty,
 not assignment. On the Window prototype indexedDB/caches are
 accessor-only (no setter), and the bootstrap is a classic sloppy-mode
 bundle, so the old plain assignment failed SILENTLY and the raw
 unscoped globals stayed in place - the E2E virtual-context isolation
 check caught it. defineProperty either installs or throws into the
 honest fallback; it cannot fail quietly. */

{
 const IDB = w.indexedDB as IDBFactory | undefined;
 if (IDB) {
 const OPEN = IDB.open.bind(IDB);
 const DEL = IDB.deleteDatabase.bind(IDB);
 /* databases() is deliberately absent (honest unimplemented API):
    wrapping it would risk leaking engine-own database names. cmp()
    (2.2 Arsenide) compares two prefixed names, so ordering stays
    consistent inside the site scope; it is absent when the host
    factory does not provide it, rather than faked. */
 const shim: Record<string, unknown> = {
 open: (n: string, v?: number) => OPEN(pre(n), v),
 deleteDatabase: (n: string) => DEL(pre(n)),
 };
 if (typeof IDB.cmp === "function") {
 const CMP = IDB.cmp.bind(IDB);
 shim.cmp = (a: string, b: string) => CMP(pre(a), pre(b));
 }
 try {
 Object.defineProperty(w, "indexedDB", { value: shim, configurable: true });
 } catch { /* read-only: stays unscoped */ }
 }
}

{
 const CA = w.caches as CacheStorage | undefined;
 if (CA) {
 const OPEN = CA.open.bind(CA);
 const DEL = CA.delete.bind(CA);
 const HAS = CA.has.bind(CA);
 const KEYS = CA.keys.bind(CA);
 const own = (n: string) => n.startsWith(P);
 const shim: Record<string, unknown> = {
 open: (n: string) => OPEN(pre(n)),
 delete: (n: string) => DEL(pre(n)),
 has: (n: string) => HAS(pre(n)),
 keys: () => KEYS().then((ks) => ks.filter(own).map((n) => n.slice(P.length))),
 match: async (rq: Request | string, o?: CacheQueryOptions) => {
 for (const n of await KEYS()) {
 if (!own(n)) continue;
 const hit = await (await CA.open(n)).match(rq, o);
 if (hit) return hit;
 }
 return undefined;
 },
 };
 try {
 Object.defineProperty(w, "caches", { value: shim, configurable: true });
 } catch { /* read-only: stays unscoped */ }
 }
}


}
