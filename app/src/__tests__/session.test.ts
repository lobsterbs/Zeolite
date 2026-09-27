import { describe, expect, it } from "vitest";
import { SESSION_ITERATIONS, b64decode, b64encode, decryptSession, encryptSession } from "../session";

describe("b64", () => {
  it("round-trips arbitrary bytes", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 16, 255]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + n) % 256;
      const rt = b64decode(b64encode(bytes));
      expect([...rt]).toEqual([...bytes]);
    }
  });
  it("rejects non-base64 input", () => {
    expect(() => b64decode("!!!")).toThrow("bad base64");
  });
});

describe("session export/import", () => {
  it("round-trips a payload and keeps it out of the blob", async () => {
    const payload = { cookies: [["o1", [{ name: "sid", value: "secret-value" }]]], tabs: [{ id: 1 }] };
    const blob = await encryptSession("correct horse battery", payload);
    expect(blob.zlSession).toBe(1);
    expect(blob.alg).toBe("AES-256-GCM/PBKDF2-SHA256");
    expect(blob.iter).toBe(SESSION_ITERATIONS);
    /* no plaintext secrets in the envelope */
    expect(JSON.stringify(blob)).not.toContain("secret-value");
    expect(JSON.stringify(blob)).not.toContain("sid");
    const back = (await decryptSession("correct horse battery", blob)) as {
      cookies: Array<[string, Array<{ name: string; value: string }>]>;
      tabs: Array<{ id: number }>;
    };
    expect(back.cookies[0][1][0].value).toBe("secret-value");
    expect(back.tabs).toEqual([{ id: 1 }]);
  });

  it("rejects a wrong passphrase", async () => {
    const blob = await encryptSession("right pass", { x: 1 });
    await expect(decryptSession("wrong pass", blob)).rejects.toThrow("wrong passphrase or corrupted blob");
  });

  it("detects tampering", async () => {
    const blob = await encryptSession("right pass", { x: 1 });
    const m = { ...blob, data: blob.data.slice(0, -4) + (blob.data.endsWith("A") ? "B" : "A") };
    await expect(decryptSession("right pass", m)).rejects.toThrow("wrong passphrase or corrupted blob");
  });

  it("rejects things that are not session blobs", async () => {
    await expect(decryptSession("p", null)).rejects.toThrow("not a session blob");
    await expect(decryptSession("p", { zlSession: 2 })).rejects.toThrow("not a Zeolite session blob");
    await expect(decryptSession("p", { zlSession: 1, alg: "ROT13", iter: 1, salt: "AAAAAAAA", iv: "AAAAAAAAAAAAAAAA", data: "AAAA" })).rejects.toThrow("not a Zeolite session blob");
    await expect(decryptSession("p", { zlSession: 1, alg: "AES-256-GCM/PBKDF2-SHA256", iter: 5e9, salt: "AAAAAAAA", iv: "AAAAAAAAAAAAAAAA", data: "AAAA" })).rejects.toThrow("not a Zeolite session blob");
  });

  it("uses fresh randomness per export", async () => {
    const a = await encryptSession("p", { x: 1 });
    const b = await encryptSession("p", { x: 1 });
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});
