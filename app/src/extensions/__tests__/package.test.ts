import { describe, expect, it } from "vitest";
import { locateManifest, readZip, type ZipLimits } from "../package";

function le16(n: number): number[] {
  return [n & 255, (n >>> 8) & 255];
}

function le32(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

interface Entry {
  name: string;
  /* The bytes stored in the archive (compressed data when method 8). */
  data: Uint8Array;
  method: 0 | 8;
  /* Lie in the declared uncompressed size (the bomb case). */
  sizeLie?: number;
  attrs?: number;
}

/* Minimal single-file zip writer: local headers + data, then the
   central directory, then EOCD. CRCs are zero; the reader never
   checks them, and these tests pin the safety gates, not zip fidelity. */
function buildZip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const cd: number[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (const e of entries) {
    const name = [...enc.encode(e.name)];
    const size = e.sizeLie ?? e.data.length;
    offsets.push(off);
    parts.push(
      ...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(e.method),
      ...le16(0), ...le16(0), ...le32(0), ...le32(e.data.length), ...le32(size),
      ...le16(name.length), ...le16(0), ...name, ...e.data,
    );
    off += 30 + name.length + e.data.length;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = [...enc.encode(e.name)];
    const size = e.sizeLie ?? e.data.length;
    cd.push(
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(e.method),
      ...le16(0), ...le16(0), ...le32(0), ...le32(e.data.length), ...le32(size),
      ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(e.attrs ?? 0), ...le32(offsets[i]), ...name,
    );
  }
  parts.push(...cd);
  parts.push(
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length),
    ...le16(entries.length), ...le32(cd.length), ...le32(off), ...le16(0),
  );
  return new Uint8Array(parts);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const LIMITS: ZipLimits = { maxEntries: 100, maxFileBytes: 2048, maxTotalBytes: 8192 };

describe("zip/xpi reader gates", () => {
  it("reads stored entries and locates the root manifest", async () => {
    const files = await readZip(
      buildZip([
        { name: "manifest.json", data: new TextEncoder().encode("{}"), method: 0 },
        { name: "dir/", data: new Uint8Array(), method: 0 },
      ]),
      LIMITS,
    );
    expect(files.size).toBe(1);
    expect(files.get("manifest.json")).toBeTruthy();
    expect(locateManifest(files)?.manifestPath).toBe("manifest.json");
  });

  it("rejects an entry whose declared size exceeds the per-file limit", async () => {
    const zip = buildZip([{ name: "big.bin", data: new Uint8Array(4096), method: 0 }]);
    await expect(readZip(zip, LIMITS)).rejects.toThrow(/file too large/i);
  });

  it("caps inflation while decompressing, before the size compare", async () => {
    /* A lying header declares 100 bytes; the payload inflates past
       the 2048-byte cap. The reader must abort mid-inflate, not
       expand the whole stream first and only then fail on the size
       mismatch. */
    const comp = await deflateRaw(new Uint8Array(4096));
    const zip = buildZip([{ name: "bomb.bin", data: comp, method: 8, sizeLie: 100 }]);
    await expect(readZip(zip, LIMITS)).rejects.toThrow(/exceeds size limit/i);
  });

  it("rejects traversal entry names", async () => {
    const zip = buildZip([{ name: "../evil.js", data: new TextEncoder().encode("x"), method: 0 }]);
    await expect(readZip(zip, LIMITS)).rejects.toThrow(/unsafe entry path/i);
  });

  it("rejects symlink entries", async () => {
    const zip = buildZip([
      { name: "link", data: new TextEncoder().encode("/etc"), method: 0, attrs: 0xa1ff0000 },
    ]);
    await expect(readZip(zip, LIMITS)).rejects.toThrow(/symlinks/i);
  });
});
