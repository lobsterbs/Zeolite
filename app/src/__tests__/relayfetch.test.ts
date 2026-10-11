import { describe, expect, it } from "vitest";
import { relayFetch, relayRegister } from "../relayfetch";

/* #137: the embedder relay over a fake port. The port contract:
   zl:fetchRelay out, head/chunk/end/error frames back per rid. */

class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  deliver(m: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}

function reg(): FakePort {
  const p = new FakePort();
  relayRegister(p as unknown as MessagePort);
  return p;
}

function head(rid: number, extra?: Record<string, unknown>) {
  return { type: "zl:relayHead", rid, status: 200, statusText: "OK", headers: [["content-type", "text/html"]], ...extra };
}

describe("relayFetch (#137)", () => {
  it("answers null without a registered channel", async () => {
    const noPort: unknown = null;
    expect(await relayFetch("https://x.example/", { method: "GET", headers: new Headers() }, "t1")).toBeNull();
    void noPort;
  });

  it("relays a full fetch: request frame, head, chunks, end", async () => {
    const p = reg();
    const respP = relayFetch("https://ddg.example/", { method: "GET", headers: new Headers({ accept: "text/html" }) }, "t2");
    const sent = p.posted[0] as { type: string; rid: number; dest: string; method: string; headers: Array<[string, string]> };
    expect(sent.type).toBe("zl:fetchRelay");
    expect(sent.dest).toBe("https://ddg.example/");
    expect(sent.method).toBe("GET");
    expect(sent.headers).toEqual([["accept", "text/html"]]);
    p.deliver(head(sent.rid, { setCookies: ["a=b; Path=/"] }));
    const enc = new TextEncoder();
    p.deliver({ type: "zl:relayChunk", rid: sent.rid, bytes: enc.encode("hel") });
    p.deliver({ type: "zl:relayChunk", rid: sent.rid, bytes: enc.encode("lo") });
    p.deliver({ type: "zl:relayEnd", rid: sent.rid });
    const resp = await respP;
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get("content-type")).toBe("text/html");
    expect((resp!.headers.getSetCookie?.() ?? [resp!.headers.get("set-cookie") ?? ""])[0]).toContain("a=b");
    expect(await resp!.text()).toBe("hello");
  });

  it("answers null on a relay error frame", async () => {
    const p = reg();
    const respP = relayFetch("https://x.example/", { method: "GET", headers: new Headers() }, "t3");
    const rid = (p.posted[0] as { rid: number }).rid;
    p.deliver({ type: "zl:relayError", rid, error: "boom" });
    expect(await respP).toBeNull();
  });

  it("refuses stream bodies the port cannot carry", async () => {
    reg();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } });
    expect(await relayFetch("https://x.example/", { method: "POST", headers: new Headers(), body }, "t4")).toBeNull();
  });

  it("carries string bodies and 304 responses honestly", async () => {
    const p = reg();
    const respP = relayFetch("https://x.example/", { method: "POST", headers: new Headers(), body: "q=1" }, "t5");
    const sent = p.posted[0] as { rid: number; body: unknown };
    expect(sent.body).toBe("q=1");
    p.deliver({ type: "zl:relayHead", rid: sent.rid, status: 304, statusText: "", headers: [] });
    p.deliver({ type: "zl:relayEnd", rid: sent.rid });
    const resp = await respP;
    expect(resp!.status).toBe(304);
    expect(resp!.body).toBeNull();
  });

  it("attaches rawHeaders so the jar sees relayed set-cookie (#10)", async () => {
    const p = reg();
    const respP = relayFetch("https://ddg.example/", { method: "GET", headers: new Headers() }, "t6");
    const sent = p.posted[0] as { rid: number };
    p.deliver(head(sent.rid, { setCookies: ["kl=no; Path=/"] }));
    p.deliver({ type: "zl:relayEnd", rid: sent.rid });
    const resp = await respP;
    const raw = (resp as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders ?? [];
    expect(raw.some(([k, v]) => k.toLowerCase() === "set-cookie" && v.includes("kl=no"))).toBe(true);
  });
});