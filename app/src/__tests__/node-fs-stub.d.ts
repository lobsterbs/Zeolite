/* Test-only ambient declaration. The app tsconfig lib set is
   DOM/WebWorker and has no node types; guest-executor.test.ts reads
   the static guest host page with node:fs under vitest. Declares the
   single function surface that test uses, nothing more. */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}
