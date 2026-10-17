import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootExtensionSubsystem,
  clientDest,
  installLifecycle,
  isHostClient,
  raceBoot,
  wireDispatchers,
  type DispatchHosts,
  type WinClient,
} from "../lifecycle";
import { DIAG } from "../diag";
import { b64uEncode, buildNavHandleUrl, setRouteKey, setScheme } from "../codec";
import type { DownloadOp, NotifyOp, ScriptingMessage, TabMessage, TabsOp } from "../extensions";

/* #243-#247: the service-worker security and lifecycle contracts
   from the sw.ts review, pinned as tests:

   - client isolation: host-only ops never reach proxied clients;
   - page-targeted delivery: tabs.sendMessage and scripting payloads
     reach only the client whose decoded destination matches;
   - install lifetime: the async prewarm is held by waitUntil and a
     rejection degrades instead of failing install;
   - partial extension failure: each boot phase fails independently
     with a diagnostic, and later phases still run. */

const ORIGIN = "https://engine.test";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

const mkClient = (url: string): { c: WinClient; messages: unknown[] } => {
  const messages: unknown[] = [];
  return { c: { url, postMessage: (m: unknown) => void messages.push(m) }, messages };
};

const navhUrl = (dest: string): string => {
  const p = buildNavHandleUrl(dest);
  if (p === null) throw new Error("mint failed (route key unset?)");
  return ORIGIN + p;
};

const stubSelf = (clients: WinClient[]): { skipWaiting: ReturnType<typeof vi.fn> } => {
  const skipWaiting = vi.fn();
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    skipWaiting,
    clients: { matchAll: async () => clients },
  });
  return { skipWaiting };
};

const mkEvent = (held: Promise<unknown>[]): ExtendableEvent =>
  ({ waitUntil: (p: Promise<unknown>) => void held.push(p) }) as unknown as ExtendableEvent;

interface Captured {
  tabsOp: ((op: TabsOp) => void) | null;
  tabMessage: ((tabId: number, tabUrl: string, extId: string, payload: TabMessage) => void) | null;
  scripting: ((msg: ScriptingMessage) => void) | null;
  downloadOp: ((op: DownloadOp) => void) | null;
  notifyOp: ((op: NotifyOp) => void) | null;
}

const capture = (): { captured: Captured; hosts: DispatchHosts } => {
  const captured: Captured = {
    tabsOp: null,
    tabMessage: null,
    scripting: null,
    downloadOp: null,
    notifyOp: null,
  };
  const hosts: DispatchHosts = {
    tabs: {
      setDispatch: (fn) => {
        captured.tabsOp = fn;
      },
      setMessageDispatch: (fn) => {
        captured.tabMessage = fn;
      },
    },
    scripting: {
      setDispatch: (fn) => {
        captured.scripting = fn;
      },
    },
    downloads: {
      setDispatch: (fn) => {
        captured.downloadOp = fn;
      },
    },
    notify: {
      setDispatch: (fn) => {
        captured.notifyOp = fn;
      },
    },
  };
  return { captured, hosts };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("client classification (#243)", () => {
  it("host clients are windows off the NAVH and engine routes; bad URLs fail closed", () => {
    stubSelf([]);
    expect(isHostClient(mkClient(ORIGIN + "/").c)).toBe(true);
    expect(isHostClient(mkClient(ORIGIN + "/devtools.html").c)).toBe(true);
    expect(isHostClient(mkClient(ORIGIN + "/__zl_navh__/garbage").c)).toBe(false);
    expect(isHostClient(mkClient(ORIGIN + "/j/xyz").c)).toBe(false);
    expect(isHostClient(mkClient("https://engine .test/").c)).toBe(false);
  });

  it("clientDest decodes a NAVH client to its destination; host pages are null", () => {
    stubSelf([]);
    expect(clientDest(mkClient(navhUrl("https://page.example/x?q=1")).c)).toBe(
      "https://page.example/x?q=1",
    );
    expect(clientDest(mkClient(ORIGIN + "/").c)).toBeNull();
  });
});

describe("install lifetime (#244)", () => {
  it("install holds the async prewarm in waitUntil and keeps skipWaiting", async () => {
    const { skipWaiting } = stubSelf([]);
    const held: Promise<unknown>[] = [];
    let release!: () => void;
    const prewarm = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    installLifecycle(mkEvent(held), prewarm);
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(held.length).toBe(1);
    release();
    await expect(held[0]).resolves.toBeUndefined();
  });

  it("a rejected prewarm degrades install instead of failing it", async () => {
    stubSelf([]);
    const held: Promise<unknown>[] = [];
    installLifecycle(mkEvent(held), () => Promise.reject(new Error("wasm cold start")));
    await expect(held[0]).resolves.toBeUndefined();
  });
});

describe("phased extension boot (#245)", () => {
  it("a failed registry restore still boots and wires the rest, with a diagnostic", async () => {
    const emit = vi.spyOn(DIAG, "emit").mockImplementation(() => undefined);
    const ran: string[] = [];
    await bootExtensionSubsystem({
      startup: () => {
        ran.push("startup");
        return Promise.reject(new Error("idb gone"));
      },
      boot: () => {
        ran.push("boot");
      },
      wireAlarm: () => {
        ran.push("alarm");
      },
      wireMgmt: () => {
        ran.push("mgmt");
      },
    });
    expect(ran).toEqual(["startup", "boot", "alarm", "mgmt"]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].category).toBe("EXTENSION");
    expect(emit.mock.calls[0][0].severity).toBe("error");
    expect(String(emit.mock.calls[0][0].message)).toContain("registry restore failed");
  });

  it("a failed enabled-extension boot does not skip alarm/mgmt wiring", async () => {
    const emit = vi.spyOn(DIAG, "emit").mockImplementation(() => undefined);
    const ran: string[] = [];
    await bootExtensionSubsystem({
      startup: () => {
        ran.push("startup");
      },
      boot: () => {
        ran.push("boot");
        throw new Error("background crash");
      },
      wireAlarm: () => {
        ran.push("alarm");
      },
      wireMgmt: () => {
        ran.push("mgmt");
      },
    });
    expect(ran).toEqual(["startup", "boot", "alarm", "mgmt"]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(String(emit.mock.calls[0][0].message)).toContain("enabled-extension boot failed");
  });

  it("alarm wiring failure still wires management", async () => {
    const emit = vi.spyOn(DIAG, "emit").mockImplementation(() => undefined);
    const ran: string[] = [];
    await bootExtensionSubsystem({
      startup: () => {
        ran.push("startup");
      },
      boot: () => {
        ran.push("boot");
      },
      wireAlarm: () => {
        ran.push("alarm");
        throw new Error("alarms unavailable");
      },
      wireMgmt: () => {
        ran.push("mgmt");
      },
    });
    expect(ran).toEqual(["startup", "boot", "alarm", "mgmt"]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(String(emit.mock.calls[0][0].message)).toContain("alarm wake wiring failed");
  });

  it("a clean boot emits no diagnostics", async () => {
    const emit = vi.spyOn(DIAG, "emit").mockImplementation(() => undefined);
    await bootExtensionSubsystem({
      startup: () => undefined,
      boot: () => undefined,
      wireAlarm: () => undefined,
      wireMgmt: () => undefined,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("dispatch wiring (#243)", () => {
  it("tab/download/notify ops reach host clients only", async () => {
    const host = mkClient(ORIGIN + "/");
    const navh = mkClient(navhUrl("https://page.example/"));
    const enginePath = mkClient(ORIGIN + "/j/abc");
    stubSelf([host.c, navh.c, enginePath.c]);
    const { captured, hosts } = capture();
    wireDispatchers(hosts, async () => [host.c, navh.c, enginePath.c]);
    captured.tabsOp!({ op: "create" });
    captured.downloadOp!({ op: "download", id: 1, extId: "ext0", url: "https://page.example/f" });
    captured.notifyOp!({ op: "clear", extId: "ext0", id: "n1" });
    await flush();
    expect(host.messages.length).toBe(3);
    expect(navh.messages.length).toBe(0);
    expect(enginePath.messages.length).toBe(0);
    expect(host.messages[0]).toEqual({ type: "zl:tabsOp", op: { op: "create" } });
  });

  it("tabs.sendMessage and scripting payloads reach only the addressed page", async () => {
    const page = mkClient(navhUrl("https://page.example/app"));
    const other = mkClient(navhUrl("https://other.example/"));
    const host = mkClient(ORIGIN + "/");
    stubSelf([page.c, other.c, host.c]);
    const { captured, hosts } = capture();
    wireDispatchers(hosts, async () => [page.c, other.c, host.c]);
    captured.tabMessage!(7, "https://page.example/app", "ext0", { nonce: "n1", msg: { hi: 1 } });
    captured.scripting!({
      type: "zl:scripting",
      extId: "ext0",
      dest: "https://page.example/app",
      js: ["void 0"],
      css: [],
    });
    await flush();
    expect(page.messages.length).toBe(2);
    expect(other.messages.length).toBe(0);
    expect(host.messages.length).toBe(0);
    /* An unmatched scripting destination is dropped, not broadcast. */
    captured.scripting!({
      type: "zl:scripting",
      extId: "ext0",
      dest: "https://nowhere.example/",
      js: ["void 0"],
      css: [],
    });
    await flush();
    expect(page.messages.length).toBe(2);
    expect(other.messages.length).toBe(0);
    expect(host.messages.length).toBe(0);
  });
});

/* #249: bounded boot. A hung boot step (storage open, extension
   phase) must never wedge the fetch handler or the control plane:
   raceBoot resolves degraded past its deadline, install bounds its
   prewarm, and a wedged extension phase does not block the phases
   after it. */
describe("bounded boot gates (#249)", () => {
  it("raceBoot passes a settled value through and propagates rejection", async () => {
    expect(await raceBoot(Promise.resolve(7), "settled", 1000)).toBe(7);
    await expect(raceBoot(Promise.reject(new Error("boom")), "rejects", 1000)).rejects.toThrow("boom");
  });

  it("raceBoot resolves undefined past the deadline instead of hanging", async () => {
    const t0 = Date.now();
    const v = await raceBoot(new Promise<number>(() => {}), "wedged", 20);
    expect(v).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("installLifecycle bounds a hanging prewarm: waitUntil still settles", async () => {
    stubSelf([]);
    const held: Promise<unknown>[] = [];
    installLifecycle(mkEvent(held), () => new Promise<void>(() => {}), 20);
    expect(held.length).toBe(1);
    await held[0];
  });

  it("bootExtensionSubsystem continues past a wedged phase", async () => {
    const ran: string[] = [];
    await bootExtensionSubsystem(
      {
        startup: () => new Promise<void>(() => {}),
        boot: () => {
          ran.push("boot");
        },
        wireAlarm: () => {
          ran.push("alarm");
        },
        wireMgmt: () => {
          ran.push("mgmt");
        },
      },
      20,
    );
    expect(ran).toEqual(["boot", "alarm", "mgmt"]);
  });
});
