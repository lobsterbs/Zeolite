/* Test-only ambient declaration. The app tsconfig lib set is
   DOM/WebWorker and has no node types; guest-executor.test.ts read
   the static guest host page with node:fs under vitest, and the #613
   wasm-arm test reads the installed @ghostery/adblocker list set the
   same way. Declares the single function surface those tests use,
   nothing more. */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}

declare module "node:module" {
  export function createRequire(path: string): { resolve(id: string): string };
}
declare module "node:path" {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}
