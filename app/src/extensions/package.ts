/* Zeolite extension subsystem: package loading (ZIP / XPI).

   XPIs are ZIPs, so one real central-directory reader covers both.
   Entries may be stored or deflate-compressed (deflate via the
   platform DecompressionStream). Extraction is defensive by
   construction: unsafe paths, symlinks, oversized archives and
   malformed directories are rejected before anything is written, and
   files only ever land under the owning extension's directory key. */

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

const CD_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LFH_SIGNATURE = 0x04034b50;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/* Inflation is capped DURING decompression, not after: a small
   compressed tail can otherwise expand gigabytes inside the worker
   before the declared-size check ever runs (decompression bomb). */
async function inflateRaw(comp: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([comp.slice().buffer as ArrayBuffer]).stream().pipeThrough(
    new DecompressionStream("deflate-raw")
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error("zeolite: inflated entry exceeds size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/* Throws on any violation; never returns a partial unsafe result. */
export async function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22) throw new Error("zeolite: archive too small to be a zip");
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(bytes, i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zeolite: no end-of-central-directory record (not a zip?)");
  const count = u16(bytes, eocd + 10);
  if (count > limits.maxEntries) {
    throw new Error("zeolite: archive declares too many entries (" + count + ")");
  }
  let off = u32(bytes, eocd + 16);
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.length || u32(bytes, off) !== CD_SIGNATURE) {
      throw new Error("zeolite: corrupt central directory at entry " + n);
    }
    const method = u16(bytes, off + 10);
    const compSize = u32(bytes, off + 20);
    const size = u32(bytes, off + 24);
    const nameLen = u16(bytes, off + 28);
    const extraLen = u16(bytes, off + 30);
    const commentLen = u16(bytes, off + 32);
    const externalAttrs = u32(bytes, off + 38);
    const localOff = u32(bytes, off + 42);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; /* directory entry */
    if (
      name.includes("\u0000") || name.includes("\\") || name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name) || name.split("/").includes("..")
    ) {
      throw new Error("zeolite: unsafe entry path in archive: " + name);
    }
    if (((externalAttrs >>> 16) & 0xf000) === 0xa000) {
      throw new Error("zeolite: symlinks are not allowed in extension packages");
    }
    if (method !== 0 && method !== 8) {
      throw new Error("zeolite: unsupported zip compression method " + method + " for " + name);
    }
    if (size > limits.maxFileBytes) {
      throw new Error("zeolite: file too large: " + name);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new Error("zeolite: archive exceeds total size limit");
    }
    if (localOff + 30 > bytes.length || u32(bytes, localOff) !== LFH_SIGNATURE) {
      throw new Error("zeolite: corrupt local header for " + name);
    }
    const lName = u16(bytes, localOff + 26);
    const lExtra = u16(bytes, localOff + 28);
    const dataStart = localOff + 30 + lName + lExtra;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : await inflateRaw(comp, limits.maxFileBytes);
    if (data.length !== size) {
      throw new Error("zeolite: size mismatch after decompression for " + name);
    }
    out.set(name, data);
  }
  if (out.size === 0) throw new Error("zeolite: archive contains no files");
  return out;
}

/* manifest.json at the root, or the single wrapper directory zips are
   often created with. Returns the manifest path and package root. */
export function locateManifest(files: Map<string, Uint8Array>): { manifestPath: string; root: string } | null {
  if (files.has("manifest.json")) return { manifestPath: "manifest.json", root: "" };
  const dirs = new Set<string>();
  for (const k of files.keys()) {
    const i = k.indexOf("/");
    if (i > 0) dirs.add(k.slice(0, i));
  }
  if (dirs.size === 1) {
    const d = [...dirs][0] as string;
    if (files.has(d + "/manifest.json")) {
      return { manifestPath: d + "/manifest.json", root: d + "/" };
    }
  }
  return null;
}
