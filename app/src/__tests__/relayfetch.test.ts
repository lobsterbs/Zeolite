import { describe, expect, it, vi } from "vitest";
import { relayFetch, relayRegister, RELAY_BODY_IDLE_MS, RELAY_HEADER_DEADLINE_MS } from "../relayfetch";

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

  /* #145: abort propagation. The engine must not keep an embedder
     fetch alive after the caller aborted. */
  const errOf = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );

  it("rejects an already-aborted signal without sending a request frame (#145)", async () => {
    const p = reg();
    const ac = new AbortController();
    ac.abort();
    const err = await errOf(
      relayFetch("https://x.example/", { method: "GET", headers: new Headers(), signal: ac.signal }, "t7"),
    );
    expect(err.name).toBe("AbortError");
    expect(p.posted).toHaveLength(0);
  });

  it("aborts a pending relay: posts zl:relayCancel and rejects the fetch (#145)", async () => {
    const p = reg();
    const ac = new AbortController();
    const respP = relayFetch("https://x.example/", { method: "GET", headers: new Headers(), signal: ac.signal }, "t8");
    const rid = (p.posted[0] as { rid: number }).rid;
    ac.abort();
    const err = await errOf(respP);
    expect(err.name).toBe("AbortError");
    expect(p.posted.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
    expect(rid).toBeGreaterThan(0);
  });

  it("errors the body stream when the abort fires mid-body (#145)", async () => {
    const p = reg();
    const ac = new AbortController();
    const respP = relayFetch("https://x.example/", { method: "GET", headers: new Headers(), signal: ac.signal }, "t9");
    const rid = (p.posted[0] as { rid: number }).rid;
    p.deliver(head(rid));
    const resp = await respP;
    ac.abort();
    const err = await errOf(resp!.body!.getReader().read());
    expect(err.name).toBe("AbortError");
    expect(p.posted.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });

  it("notifies the embedder when the caller cancels the body stream (#145)", async () => {
    const p = reg();
    const respP = relayFetch("https://x.example/", { method: "GET", headers: new Headers() }, "t10");
    const rid = (p.posted[0] as { rid: number }).rid;
    p.deliver(head(rid));
    const resp = await respP;
    await resp!.body!.cancel();
    expect(p.posted.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });
});

describe("relayFetch header deadline (#382)", () => {
  it("resolves null on a silent embedder after the deadline and cancels upstream", async () => {
    const p = reg();
    vi.useFakeTimers();
    try {
      const pending = relayFetch(
        "https://cdn.example.com/a.js",
        { method: "GET", headers: new Headers() },
        "t1",
      );
      await vi.advanceTimersByTimeAsync(RELAY_HEADER_DEADLINE_MS + 1);
      await expect(pending).resolves.toBeNull();
      expect(p.posted.some((m) => (m as { type?: string }).type === "zl:relayCancel")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});


/* #681 follow-up (white ESTS authorize tabs on LB beta): the body
   phase had no liveness bound. A head delivered, then the relay
   channel died mid-body (embedder page frozen or closed, port
   dropped by the 15 s keep-alive re-registration, pump loop killed)
   and the pull parked forever: the tab sat white with zero events
   past the head, and the favicon (a document subresource) never even
   issued. The watchdog races each body pull against
   RELAY_BODY_IDLE_MS and converts every silent-death subclass into
   an honest stream error plus a zl:relayCancel to the embedder.
   Port pinning keeps a replaced registration's channel alive while
   its fetches still drain. */

describe("relayFetch body-idle watchdog (#681 follow-up)", () => {
  const errOf = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );

  it("errors the body after the idle bound, cancels upstream instead of parking", async () => {
    const p = reg();
    vi.useFakeTimers();
    try {
      const respP = relayFetch("https://login.example/authorize", { method: "GET", headers: new Headers() }, "w1");
      const rid = (p.posted[0] as { rid: number }).rid;
      p.deliver(head(rid, { setCookies: [] }));
      const resp = await respP;
      /* head landed, channel goes silent: no chunk, no end, no error.
         Attach the rejection handler SYNCHRONOUSLY: the read rejects
         mid-advance and an unattached macrotask crossing triggers
         Node's unhandledRejection report. */
      const errP = errOf(resp!.body!.getReader().read());
      await vi.advanceTimersByTimeAsync(RELAY_BODY_IDLE_MS + 1);
      const err = await errP;
      expect(err.message).toContain("relay body idle");
      expect(p.posted.some((m) => (m as { type?: string }).type === "zl:relayCancel")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving when frames arrive before the idle bound", async () => {
    const p = reg();
    vi.useFakeTimers();
    try {
      const respP = relayFetch("https://ddg.example/", { method: "GET", headers: new Headers() }, "w2");
      const rid = (p.posted[0] as { rid: number }).rid;
      p.deliver(head(rid));
      const resp = await respP;
      /* one reader for the whole body: a second getReader() would
         lock-error on the held stream */
      const reader = resp!.body!.getReader();
      const enc = new TextEncoder();
      const readP = reader.read();
      await vi.advanceTimersByTimeAsync(RELAY_BODY_IDLE_MS - 1);
      p.deliver({ type: "zl:relayChunk", rid, bytes: enc.encode("ok") });
      const first = await readP;
      expect(new TextDecoder().decode(first!.value as Uint8Array)).toBe("ok");
      p.deliver({ type: "zl:relayEnd", rid });
      const done = await reader.read();
      expect(done!.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("relay port pinning across re-registration (#681 follow-up)", () => {
  it("still serves in-flight fetches on the replaced port after a newer registration", async () => {
    const portA = reg();
    const respP = relayFetch("https://outlook.example/mail/", { method: "GET", headers: new Headers() }, "w3");
    const rid = (portA.posted[0] as { rid: number }).rid;
    portA.deliver(head(rid));
    const resp = await respP;
    /* the 15 s keep-alive re-registration replaces hostPort mid-body */
    const portB = reg();
    expect(portB).not.toBe(portA);
    const enc = new TextEncoder();
    portA.deliver({ type: "zl:relayChunk", rid, bytes: enc.encode("hel") });
    portA.deliver({ type: "zl:relayChunk", rid, bytes: enc.encode("lo") });
    portA.deliver({ type: "zl:relayEnd", rid });
    expect(await resp!.text()).toBe("hello");
  });
});
