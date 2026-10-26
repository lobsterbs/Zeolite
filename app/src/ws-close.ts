/** Apply Web IDL unsigned-short/USVString conversions before close validation. */
export function validateWsClose(code?: unknown, reason?: unknown): { code?: number; reason?: string } {
  let normalizedCode: number | undefined;
  if (code !== undefined) {
    // Unary + uses ToNumber: unlike Number(), it rejects BigInt.
    const n = +(code as number);
    normalizedCode = Number.isFinite(n) ? ((Math.trunc(n) % 65536) + 65536) % 65536 : 0;
  }
  let normalizedReason: string | undefined;
  let reasonBytes: Uint8Array | undefined;
  if (reason !== undefined) {
    if (typeof reason === "symbol") throw new TypeError("Symbol");
    reasonBytes = new TextEncoder().encode(String(reason));
    // USVString replaces lone surrogates; preserve an initial BOM.
    normalizedReason = new TextDecoder("utf-8", { ignoreBOM: true }).decode(reasonBytes);
  }
  if (normalizedCode !== undefined && normalizedCode !== 1000 && (normalizedCode < 3000 || normalizedCode > 4999)) {
    throw new DOMException("Close code", "InvalidAccessError");
  }
  if (reasonBytes && reasonBytes.byteLength > 123) {
    throw new DOMException("Reason too long", "SyntaxError");
  }
  return { code: normalizedCode, reason: normalizedReason };
}
