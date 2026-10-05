/* Engine selection + ESM glue transform tests for the transport seam
   (issue #64). The seam keeps the libcurl path byte-identical; these
   cover the new pure surface only. */

import { describe, it, expect } from "vitest";
import { setEngine, currentEngine, stripEsmExports, inlineDataImports } from "../libcurl-transport-vendored";

describe("transport engine selection", () => {
  it("defaults to libcurl", () => {
    expect(currentEngine()).toBe("libcurl");
  });

  it("setEngine/currentEngine round-trip", () => {
    try {
      setEngine("epoxy");
      expect(currentEngine()).toBe("epoxy");
      setEngine("libcurl");
      expect(currentEngine()).toBe("libcurl");
    } finally {
      setEngine("libcurl");
    }
  });

  it("rejects unknown engines honestly", () => {
    expect(() => setEngine("winsock" as never)).toThrow(/unknown transport engine/);
  });
});

describe("stripEsmExports (epoxy glue loader)", () => {
  const src = [
    "export class A { constructor() { this.x = 1; } }",
    "export default function __wbg_init(p) { return p; }",
    "export const info = { v: 1 };",
    "const wasmUrl = new URL('epoxy.wasm', import.meta.url);",
    "export { A };",
  ].join("\n");

  it("strips every export statement and pins import.meta.url", () => {
    const out = stripEsmExports(src, "https://e.example/epoxy.wasm");
    expect(out).not.toMatch(/\bexport\b/);
    expect(out).toContain('"https://e.example/epoxy.wasm"');
    expect(out).not.toContain("import.meta");
  });

  it("produces an evaluable body with the expected bindings", () => {
    const out = stripEsmExports(src, "https://e.example/epoxy.wasm");
    const factory = new Function(out + "\nreturn { A, init: __wbg_init, info };");
    const m = factory() as { A: new () => { x: number }; init: (p: string) => string; info: { v: number } };
    expect(new m.A().x).toBe(1);
    expect(m.init("ok")).toBe("ok");
    expect(m.info.v).toBe(1);
  });
});

describe("inlineDataImports (epoxy glue loader)", () => {
  const helper = "export function ws_key() { return 'k'; }\nexport const tag = 7;\n";
  const src = [
    "import { ws_key, tag } from 'data:text/javascript;base64," + btoa(helper) + "';",
    "const used = ws_key();",
  ].join("\n");

  it("splices the decoded data: module in place of the import statement", () => {
    const out = stripEsmExports(inlineDataImports(src), "https://e.example/epoxy.wasm");
    expect(out).not.toMatch(/\bimport\b/);
    expect(out).not.toMatch(/\bexport\b/);
    const factory = new Function(out + "\nreturn { ws_key, tag, used };");
    const m = factory() as { ws_key: () => string; tag: number; used: string };
    expect(m.ws_key()).toBe("k");
    expect(m.tag).toBe(7);
    expect(m.used).toBe("k");
  });
});
