import { describe, expect, it } from "vitest";

/* #531 acceptance: unit coverage for the engine-side subresource
   integrity layer - metadata parsing, byte verification, entity
   decoding, the incremental document scanner, the per-client
   expectation registry, and the blocked-response envelope. */

import {
  SRI_CLIENTS_CAP,
  SRI_ENTRIES_CAP,
  bytesToB64,
  decodeEntities,
  newSriRegistry,
  parseSri,
  sriBlockedResponse,
  sriClearClient,
  sriExpectation,
  sriNote,
  sriScanner,
  sriVerifyBytes,
} from "../sri";

const enc = new TextEncoder();

const ALG_NAME: Record<string, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

async function integrityOf(text: string, alg = "sha256"): Promise<string> {
  const d = await crypto.subtle.digest(ALG_NAME[alg], enc.encode(text));
  return alg + "-" + bytesToB64(new Uint8Array(d));
}

describe("bytesToB64 (#531)", () => {
  it("encodes the RFC 4648 vectors", () => {
    expect(bytesToB64(enc.encode(""))).toBe("");
    expect(bytesToB64(enc.encode("f"))).toBe("Zg==");
    expect(bytesToB64(enc.encode("fo"))).toBe("Zm8=");
    expect(bytesToB64(enc.encode("foo"))).toBe("Zm9v");
    expect(bytesToB64(enc.encode("foob"))).toBe("Zm9vYg==");
    expect(bytesToB64(enc.encode("fooba"))).toBe("Zm9vYmE=");
    expect(bytesToB64(enc.encode("foobar"))).toBe("Zm9vYmFy");
  });
});

describe("parseSri (#531)", () => {
  it("parses a single supported token", () => {
    const c = parseSri("sha256-QAAA");
    expect(c.supported).toEqual([{ alg: "sha256", b64: "QAAA" }]);
    expect(c.unsupported).toBe(false);
    expect(c.malformed).toBe(false);
  });

  it("parses multiple whitespace-separated tokens", () => {
    const c = parseSri("sha384-X sha512-Y");
    expect(c.supported).toEqual([
      { alg: "sha384", b64: "X" },
      { alg: "sha512", b64: "Y" },
    ]);
  });

  it("flags an unknown algorithm without dropping supported siblings", () => {
    const c = parseSri("sha256-QAAA md5-ZZZ");
    expect(c.supported).toEqual([{ alg: "sha256", b64: "QAAA" }]);
    expect(c.unsupported).toBe(true);
    expect(c.malformed).toBe(false);
  });

  it("flags tokens without a dash or with a non-base64 tail as malformed", () => {
    expect(parseSri("sha256").malformed).toBe(true);
    expect(parseSri("sha256-A!B").malformed).toBe(true);
    const c = parseSri("sha256-QAAA broken");
    expect(c.malformed).toBe(true);
    expect(c.supported).toEqual([{ alg: "sha256", b64: "QAAA" }]);
  });

  it("returns no candidates for an empty attribute", () => {
    const c = parseSri("   ");
    expect(c.supported).toEqual([]);
    expect(c.unsupported).toBe(false);
    expect(c.malformed).toBe(false);
  });
});

describe("sriVerifyBytes (#531)", () => {
  it("verifies a correct sha256 over the raw bytes", async () => {
    const integ = await integrityOf("hello world");
    expect(await sriVerifyBytes(enc.encode("hello world").slice().buffer, integ, false)).toBe("verified");
  });

  it("verifies when any candidate algorithm matches", async () => {
    const bad256 = "sha256-" + "A".repeat(43) + "=";
    const good512 = await integrityOf("payload", "sha512");
    const integ = bad256 + " " + good512;
    expect(await sriVerifyBytes(enc.encode("payload").slice().buffer, integ, false)).toBe("verified");
  });

  it("blocks when every supported candidate mismatches", async () => {
    const integ = await integrityOf("something else");
    expect(await sriVerifyBytes(enc.encode("tampered body").slice().buffer, integ, false)).toBe("blocked");
  });

  it("skips with a reason when the body exceeds the cap, the algorithm is unknown, the metadata is malformed, or no candidate exists", async () => {
    const buf = enc.encode("x").slice().buffer;
    expect(await sriVerifyBytes(buf, "sha256-QAAA", true)).toBe("skipped:body-too-large");
    expect(await sriVerifyBytes(buf, "md5-QAAA", false)).toBe("skipped:unsupported-algorithm");
    expect(await sriVerifyBytes(buf, "sha256-A!B", false)).toBe("skipped:malformed");
    expect(await sriVerifyBytes(buf, "", false)).toBe("skipped:no-candidates");
  });
});

describe("decodeEntities (#531)", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a&amp;b")).toBe("a&b");
    expect(decodeEntities("&#38;")).toBe("&");
    expect(decodeEntities("&#x26;")).toBe("&");
    expect(decodeEntities("&quot;")).toBe('"');
    expect(decodeEntities("&#39;")).toBe("'");
  });

  it("keeps unknown entities and plain text intact", () => {
    expect(decodeEntities("&nbsp;")).toBe("&nbsp;");
    expect(decodeEntities("plain")).toBe("plain");
  });
});

describe("sriScanner (#531)", () => {
  const BASE = "https://t.example/page";

  function scan(chunks: string[]): Array<[string, string]> {
    const notes: Array<[string, string]> = [];
    const sc = sriScanner(BASE, (abs, integ) => notes.push([abs, integ]));
    for (const ch of chunks) sc.feed(ch);
    return notes;
  }

  it("collects a quoted script src with integrity", () => {
    expect(scan(['<html><script src="/a.js" integrity="sha256-AAA"></script>'])).toEqual([
      ["https://t.example/a.js", "sha256-AAA"],
    ]);
  });

  it("collects single-quoted and bare attribute values", () => {
    expect(scan(["<script src='/b.js' integrity='sha256-B'></script>"])).toEqual([
      ["https://t.example/b.js", "sha256-B"],
    ]);
    expect(scan(["<script src=/c.js integrity=sha256-C></script>"])).toEqual([
      ["https://t.example/c.js", "sha256-C"],
    ]);
  });

  it("collects link rel=stylesheet but not other rel values", () => {
    expect(scan(['<link rel="stylesheet" href="/s.css" integrity="sha512-S">'])).toEqual([
      ["https://t.example/s.css", "sha512-S"],
    ]);
    expect(scan(['<link rel="icon" href="/i.png" integrity="sha256-I">'])).toEqual([]);
    expect(scan(['<link rel="preload" href="/p.js" integrity="sha256-P">'])).toEqual([]);
  });

  it("ignores inline scripts and tags without integrity", () => {
    expect(scan(["<script>integrity=1</script>"])).toEqual([]);
    expect(scan(['<script src="/d.js"></script>'])).toEqual([]);
  });

  it("holds an opening tag split across chunks", () => {
    expect(scan(["<html><script sr", 'c="/split.js" integrity="sha256-K"></script>'])).toEqual([
      ["https://t.example/split.js", "sha256-K"],
    ]);
  });

  it("decodes entities inside the recorded URL", () => {
    expect(scan(['<script src="/a.js?x=1&amp;y=2" integrity="sha256-E"></script>'])).toEqual([
      ["https://t.example/a.js?x=1&y=2", "sha256-E"],
    ]);
  });

  it("ignores non-http schemes", () => {
    expect(scan(['<script src="data:text/plain,x" integrity="sha256-D"></script>'])).toEqual([]);
  });

  it("stops after the entries cap", () => {
    let tag = "";
    for (let i = 0; i < SRI_ENTRIES_CAP + 5; i++) {
      tag += '<script src="/n' + i + '.js" integrity="sha256-N"></script>';
    }
    const notes = scan([tag]);
    expect(notes.length).toBe(SRI_ENTRIES_CAP);
  });
});

describe("sri registry (#531)", () => {
  it("notes and returns expectations per client", () => {
    const reg = newSriRegistry();
    sriNote(reg, "c1", "https://t.example/a.js", "sha256-A");
    expect(sriExpectation(reg, "c1", "https://t.example/a.js")).toBe("sha256-A");
    expect(sriExpectation(reg, "c1", "https://t.example/b.js")).toBeUndefined();
    expect(sriExpectation(reg, "c2", "https://t.example/a.js")).toBeUndefined();
    expect(sriExpectation(reg, undefined, "https://t.example/a.js")).toBeUndefined();
  });

  it("clears one client without touching others", () => {
    const reg = newSriRegistry();
    sriNote(reg, "c1", "https://t.example/a.js", "sha256-A");
    sriNote(reg, "c2", "https://t.example/a.js", "sha256-A");
    sriClearClient(reg, "c1");
    expect(sriExpectation(reg, "c1", "https://t.example/a.js")).toBeUndefined();
    expect(sriExpectation(reg, "c2", "https://t.example/a.js")).toBe("sha256-A");
  });

  it("caps entries per client by dropping the oldest", () => {
    const reg = newSriRegistry();
    for (let i = 0; i < SRI_ENTRIES_CAP + 10; i++) {
      sriNote(reg, "c", "https://t.example/n" + i + ".js", "sha256-N");
    }
    expect(reg.clients.get("c")!.size).toBe(SRI_ENTRIES_CAP);
    expect(reg.clients.get("c")!.has("https://t.example/n0.js")).toBe(false);
    expect(reg.clients.get("c")!.has("https://t.example/n" + (SRI_ENTRIES_CAP + 9) + ".js")).toBe(true);
  });

  it("caps the client count by dropping the oldest client", () => {
    const reg = newSriRegistry();
    for (let i = 0; i < SRI_CLIENTS_CAP + 10; i++) {
      sriNote(reg, "c" + i, "https://t.example/a.js", "sha256-A");
    }
    expect(reg.clients.size).toBe(SRI_CLIENTS_CAP);
    expect(reg.clients.has("c0")).toBe(false);
  });
});

describe("sriBlockedResponse (#531)", () => {
  it("serves a no-store 500 with the blocked marker for both destinations", async () => {
    for (const dest of ["script", "style"]) {
      const r = sriBlockedResponse(dest, 200);
      expect(r.status).toBe(500);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-zl-sri")).toBe("blocked");
      expect((r.headers.get("content-type") ?? "").includes(dest === "script" ? "javascript" : "css")).toBe(true);
      expect((await r.text()).includes("integrity")).toBe(true);
    }
  });
});
