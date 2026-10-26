/** Page/worker WebSocket send() payload and UTF-8 byte accounting (#462).
    The bridge sees a structured-cloned payload; its drain message
    acknowledges transport acceptance, not receipt by the remote peer. */
export function wsPayload(data: unknown): { data: string | Blob | ArrayBuffer | ArrayBufferView; bytes: number } {
  if (data instanceof Blob) return { data, bytes: data.size };
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return { data, bytes: data.byteLength };
  // Web IDL's USVString conversion rejects Symbols. String() alone does not.
  if (typeof data === "symbol") throw new TypeError("Symbol");
  const text = String(data);
  return { data: text, bytes: new TextEncoder().encode(text).byteLength };
}
