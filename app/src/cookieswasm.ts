/* #614: lazy loader for the CI-generated zeolite-cookies-wasm glue
   (the RFC 6265 jar registry compiled by wasm-pack). The glue MODULE
   is statically imported (the SW-scope loading lint forbids dynamic
   import() in SW-reachable code), but the glue's default() only
   FETCHES the wasm binary and instantiates its linear memory when
   called: that happens at service worker boot, from cookies.ts
   initCookiesWasm, which wraps the tldts predicate into setPsl and
   performs the one-time jar cutover. One lazy init, no retry - the
   seam.ts lifecycle pattern: a rejected init keeps every jar seam on
   its TS fallback body in cookies.ts. No DIAG import here: cookies.ts
   owns the diagnostics for the arm it selects. */
import * as cookiesWasm from "./cookies_wasm/cookies_wasm.js";

export interface CookiesWasmCore {
  /** Inject the public-suffix predicate (tldts stays TS-side). */
  setPsl(f: (domain: string) => boolean): void;
  /** Admit raw Set-Cookie headers for one response origin into one
      bucket; JSON outcome array in header order (TS SetCookieResult
      shape, camelCase cookies, TS reject strings). */
  storeBatch(ns: string, bucket: string, originUrl: string, headersJson: string, fromScript: boolean, now: number): string;
  /** RFC 6265 5.4 request match: { matched, purged } JSON. */
  matchRequest(ns: string, requestUrl: string, now: number): string;
  /** document.cookie oracle: matched cookies JSON in 5.4 order. */
  matchDocument(ns: string, pageUrl: string, now: number): string;
  /** The 6.1 sweep without protection; removed cookies JSON. */
  sweep(ns: string, now: number): string;
  /** Retire identities; returns how many cookies died. */
  removeIdentities(ns: string, idsJson: string): number;
  /** One namespace as [[bucketId, [cookie, ...]], ...] JSON. */
  exportNs(ns: string): string;
  /** Every namespace as { ns: entries } JSON. */
  exportAll(): string;
  /** Replace a whole namespace; returns the stored cookie count. */
  replaceNs(ns: string, entriesJson: string): number;
  /** Session-import merge; { jars, cookies, conflicts } JSON. */
  mergeNs(ns: string, entriesJson: string, rule: string): string;
  /** Clear one namespace; { jars, cookies } JSON. */
  clearNs(ns: string): string;
  /** Clear one origin bucket; returns how many cookies died. */
  clearBucket(ns: string, bucket: string): number;
  /** Teardown: drop every namespace (the PSL stays injected). */
  clearAll(): void;
  /** wasm-pack --target web async init. */
  default(path?: unknown): Promise<unknown>;
}

let glueInit: Promise<CookiesWasmCore> | null = null;

/** Instantiate the cookies wasm glue once. The caller owns the
    rejection (cookies.ts emits one DIAG row and keeps the TS jar
    arm); a rejected init is memoized, so later attempts ride the
    same settled promise and never re-init. */
export function initCookiesWasmGlue(): Promise<CookiesWasmCore> {
  if (!glueInit) {
    glueInit = (async () => {
      const mod = cookiesWasm as unknown as CookiesWasmCore;
      await mod.default(new URL("cookies_wasm_bg.wasm", self.location.href));
      return mod;
    })();
  }
  return glueInit;
}
