import { expect, it } from "vitest";
import { validateWsClose } from "../ws-close";

it.each([["1000", 1000], [3000.9, 3000], [65536 + 1000, 1000], [-64536, 1000]])("normalizes close code %s as Web IDL unsigned short", (input, expected) => {
  expect(validateWsClose(input).code).toBe(expected);
});
it("normalizes a reason once and replaces lone surrogates without losing a BOM", () => {
  let calls = 0;
  expect(validateWsClose(1000, { toString() { calls++; return "\ufeffa\ud800"; } }).reason).toBe("\ufeffa\ufffd");
  expect(calls).toBe(1);
});
it("rejects Symbol/BigInt conversion and checks UTF-8 bytes after conversion", () => {
  expect(() => validateWsClose(1000n)).toThrow(TypeError);
  expect(() => validateWsClose(1000, Symbol())).toThrow(TypeError);
  expect(() => validateWsClose(1001, Symbol())).toThrow(TypeError);
  expect(() => validateWsClose(1000, "é".repeat(62))).toThrowError(expect.objectContaining({ name: "SyntaxError" }));
  expect(validateWsClose(1000, "a".repeat(123)).reason?.length).toBe(123);
});
