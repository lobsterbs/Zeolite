/* Stall-storm cooldown (2026-10-11 YouTube diag): three first-byte
   stalls within the window flip the transport into relay-first
   cooldown. Without a relay channel the wisp path stays honest (and
   a success clears the storm); with a registered embedder relay the
   requests ride it instead of eating another 30s deadline. The
   vendored module is mocked: these tests exercise the storm state
   machine, not the wasm transport. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchImpl: (_d: string, _i?: RequestInit): Promise<Response> => new Promise<Response>(() => {}),
}));

vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => {},
  fetch: (d: string, i?: RequestInit) => h.fetchImpl(d, i),
  isConnectClassError: () => false,
  reset: () => {},
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => {
    throw new Error("not used here");
  },
}));

import { transportResetForTests, wispCoolingForTests, wispTransport } from "../transport";
import { relayRegister } from "../relayfetch";
import { DIAG } from "../diag";


beforeEach(() => {
  transportResetForTests(15);
});

class FakePort {
  sent: unknown[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  postMessage(m: unknown): void {
    this.sent.push(m);
    const rid = (m as { rid: number }).rid;
    const fire = (data: unknown) => this.onmessage?.(new MessageEvent("message", { data }));
    setTimeout(() => {
      fire({ type: "zl:relayHead", rid, status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] });
      fire({ type: "zl:relayEnd", rid });
    }, 0);
  }
}

describe("wisp stall-storm cooldown", () => {
  it("three stalls within the window arm the cooldown; without a relay the wisp path stays honest", async () => {
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    /* no relay registered: the cooldown cannot carry the request, the
       wisp stall surfaces honestly instead of failing fast */
    const fourth = await wispTransport.fetch("https://a.example/4").then(
      () => "resolved",
      (err: Error) => String(err),
    );
    expect(fourth).toContain("no first byte within 15ms");
  });

  it("a first-byte wisp success clears the storm window and the cooldown", async () => {
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    h.fetchImpl = () => Promise.resolve(new Response("ok", { status: 200 }));
    const resp = await wispTransport.fetch("https://a.example/heal");
    expect(await resp.text()).toBe("ok");
    expect(wispCoolingForTests()).toBe(false);
  });

  it("during cooldown a registered relay serves the request", async () => {
    /* re-arm: the healed impl from the previous test stalls again */
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    relayRegister(new FakePort() as unknown as MessagePort);
    const resp = await wispTransport.fetch("https://a.example/relayed");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("");
  });

  it("cooldown relay propagates the abort signal to the embedder (#145)", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    class QuietPort {
      sent: unknown[] = [];
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(m: unknown): void {
        this.sent.push(m);
      }
    }
    const port = new QuietPort();
    relayRegister(port as unknown as MessagePort);
    const ac = new AbortController();
    const respP = wispTransport.fetch("https://a.example/abortme", { signal: ac.signal });
    ac.abort();
    const err = await respP.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.name).toBe("AbortError");
    expect(port.sent.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });
});

describe("cooldown diagnostics and retry accounting (#226)", () => {
  it("records the retry stall too, so two wedged requests arm the cooldown", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    /* each fetch contributes two stalls now: attempt + retry */
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
  });

  it("cooldown relay failures carry the request trace id", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    /* arm the cooldown first: without it the wisp path runs, not the relay */
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    class ErrorPort {
      sent: unknown[] = [];
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(m: unknown): void {
        this.sent.push(m);
        const rid = (m as { rid: number }).rid;
        setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: { type: "zl:relayError", rid, error: "nope" } })), 0);
      }
    }
    relayRegister(new ErrorPort() as unknown as MessagePort);
    const seen: Array<{ message?: string; traceId?: string }> = [];
    const spy = vi.spyOn(DIAG, "emit").mockImplementation((e: { message?: string; traceId?: string }) => {
      seen.push(e);
    });
    await wispTransport.fetch("https://a.example/traced", undefined, "zl-tr-cool").catch(() => {});
    spy.mockRestore();
    const ev = seen.find((e) => String(e.message ?? "").includes("embedder relay failed"));
    expect(ev).toBeTruthy();
    expect(ev?.traceId).toBe("zl-tr-cool");
  });
});
/* #261: the cooldown relay branch must carry its own first-byte
   deadline (relayFetch has none by design). Appended LAST: the
   relay port is module state, each test re-registers its own. */
describe("cooldown relay first-byte deadline (#261)", () => {
  it("a silent embedder relay gets the same TTFB bound and cancels the upstream", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    class SilentPort {
      sent: unknown[] = [];
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(m: unknown): void {
        this.sent.push(m);
      }
    }
    const port = new SilentPort();
    relayRegister(port as unknown as MessagePort);
    const err = await wispTransport.fetch("https://a.example/silent").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(String(err)).toContain("relay transport stall: no first byte within 15ms");
    expect(port.sent.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });

  it("a caller abort settles as AbortError, not a stall (#261)", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    class HushedPort {
      sent: unknown[] = [];
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(m: unknown): void {
        this.sent.push(m);
      }
    }
    const port = new HushedPort();
    relayRegister(port as unknown as MessagePort);
    const ac = new AbortController();
    const respP = wispTransport.fetch("https://a.example/abort2", { signal: ac.signal });
    ac.abort();
    const err = await respP.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.name).toBe("AbortError");
    expect(String(err)).not.toContain("relay transport stall");
    expect(port.sent.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });
});

/* #400: a stall on the cooldown relay arm feeds the storm detector.
   Without the record, a wedged relay looked healthy the moment the
   cooldown expired: the arming stalls age out of the 60s storm
   window and the post-cooldown wisp stalls never reach the
   threshold. The frozen Date.now makes the window arithmetic
   observable without real 60s waits; the first-byte deadlines
   themselves stay real 15ms setTimeout ticks. */
describe("relay stalls feed the storm detector (#400)", () => {
  it("a relay stall during cooldown refreshes the storm window", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    let t = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => t);
    const seen: Array<{ message?: string }> = [];
    const emit = vi.spyOn(DIAG, "emit").mockImplementation((e: { message?: string }) => {
      seen.push(e);
    });
    try {
      await Promise.allSettled([
        wispTransport.fetch("https://a.example/1"),
        wispTransport.fetch("https://a.example/2"),
      ]);
      expect(wispCoolingForTests()).toBe(true);
      class MutePort {
        sent: unknown[] = [];
        onmessage: ((ev: MessageEvent) => void) | null = null;
        postMessage(m: unknown): void {
          this.sent.push(m);
        }
      }
      relayRegister(new MutePort() as unknown as MessagePort);
      t = 1_010_000;
      const err = await wispTransport.fetch("https://a.example/silent").then(
        () => {
          throw new Error("expected rejection");
        },
        (e: Error) => e,
      );
      expect(String(err)).toContain("relay transport stall");
      /* past the cooldown: the arming stalls (t=1_000_000) aged out
         of the 60s window; only the recorded relay stall keeps the
         count at threshold when the wisp stalls land */
      t = 1_070_000;
      seen.length = 0;
      await Promise.allSettled([wispTransport.fetch("https://a.example/after")]);
      expect(seen.some((e) => String(e.message ?? "").includes("wisp stall storm"))).toBe(true);
    } finally {
      emit.mockRestore();
      clock.mockRestore();
    }
  });
});
