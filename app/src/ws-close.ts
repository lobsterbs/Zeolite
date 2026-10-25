/** Validate WebSocket.close arguments before changing readyState. */
export function validateWsClose(code?: number, reason?: string): { code?: number; reason?: string } {
  if (code !== undefined && (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999))) {
    throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
  }
  if (reason !== undefined && new TextEncoder().encode(String(reason)).byteLength > 123) {
    throw new DOMException("WebSocket close reason exceeds 123 bytes", "SyntaxError");
  }
  return { code, reason };
}
