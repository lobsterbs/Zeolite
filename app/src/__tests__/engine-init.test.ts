import { afterEach, describe, expect, it, vi } from "vitest";
import { ZeoliteEngine } from "../engine";

/* init() must resolve false when the SW never takes control of the
   page (the host reloads once, guarded) and true when it does: a
   resolved-but-uncontrolled init() used to look like success. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubSW(controller: unknown) {
  const register = vi.fn().mockResolvedValue({ scope: "/" });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller,
      register,
      ready: Promise.resolve({}),
    },
  });
  return register;
}

describe("ZeoliteEngine.init() control verdict", () => {
  it("resolves false when the controller never arrives", async () => {
    vi.useFakeTimers();
    stubSW(null);
    let verdict: boolean | undefined;
    const pending = new ZeoliteEngine().init().then((v) => {
      verdict = v;
    });
    /* the controller poll is 50 x 100ms: advance past its whole
       window, flushing the awaited sleeps between iterations */
    await vi.advanceTimersByTimeAsync(5200);
    await pending;
    expect(verdict).toBe(false);
  });

  it("registers as a module SW at the origin root", async () => {
    vi.useFakeTimers();
    const register = stubSW(null);
    const pending = new ZeoliteEngine().init();
    await vi.advanceTimersByTimeAsync(5200);
    await pending;
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", type: "module" });
  });

  it("resolves true and pushes config when the page is controlled", async () => {
    const posted: unknown[] = [];
    stubSW({
      postMessage: (msg: unknown, ports: MessagePortLike[]) => {
        posted.push(msg);
        ports[0]!.postMessage({ ok: true });
      },
    });
    const ok = await new ZeoliteEngine().init();
    expect(ok).toBe(true);
    expect(posted[0]).toMatchObject({ type: "zl:config", prefix: "/j/" });
  });
});

interface MessagePortLike {
  postMessage(data: unknown): void;
}

describe("control acknowledgement verdicts (#252)", () => {
  it("init() resolves false when the worker refuses the config", async () => {
    stubSW({
      postMessage: (msg: unknown, ports: MessagePortLike[]) => {
        ports[0]!.postMessage({ ok: false, error: "bad prefix" });
      },
    });
    const ok = await new ZeoliteEngine().init();
    expect(ok).toBe(false);
  });

  it("init() resolves false when the config acknowledgement times out", async () => {
    vi.useFakeTimers();
    stubSW({ postMessage: () => {} });
    const pending = new ZeoliteEngine().init();
    await vi.advanceTimersByTimeAsync(5200);
    expect(await pending).toBe(false);
  });

  it("a late acknowledgement after the timeout cannot resurrect the verdict", async () => {
    vi.useFakeTimers();
    const late: { reply?: (v: unknown) => void } = {};
    stubSW({
      postMessage: (_msg: unknown, ports: MessagePortLike[]) => {
        late.reply = (v: unknown) => ports[0]!.postMessage(v);
      },
    });
    const pending = new ZeoliteEngine().init();
    await vi.advanceTimersByTimeAsync(5200);
    expect(await pending).toBe(false);
    late.reply?.({ ok: true });
    await vi.advanceTimersByTimeAsync(100);
  });
});

describe("setSiteRoute acknowledgement (#252)", () => {
  function stubWithStore(controller: unknown) {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    stubSW(controller);
    return store;
  }

  it("persists the toggle only after an acknowledged reply", async () => {
    const store = stubWithStore({
      postMessage: (_msg: unknown, ports: MessagePortLike[]) => {
        ports[0]!.postMessage({ ok: true });
      },
    });
    await new ZeoliteEngine().setSiteRoute("https://a.example/", false);
    expect(JSON.parse(store.get("zl:disabled-sites")!)).toContain("https://a.example/");
  });

  it("throws and does not persist when the worker refuses", async () => {
    const store = stubWithStore({
      postMessage: (_msg: unknown, ports: MessagePortLike[]) => {
        ports[0]!.postMessage({ ok: false, error: "no" });
      },
    });
    await expect(
      new ZeoliteEngine().setSiteRoute("https://b.example/", false),
    ).rejects.toThrow("zl:siteRoute");
    expect(store.has("zl:disabled-sites")).toBe(false);
  });

  it("throws on timeout and does not persist", async () => {
    vi.useFakeTimers();
    const store = stubWithStore({ postMessage: () => {} });
    const pending = new ZeoliteEngine().setSiteRoute("https://c.example/", false);
    const caught = pending.catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(5200);
    expect(String(await caught)).toContain("timeout");
    expect(store.has("zl:disabled-sites")).toBe(false);
  });
});
