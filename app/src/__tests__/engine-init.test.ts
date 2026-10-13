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
