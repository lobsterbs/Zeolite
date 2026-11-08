import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #550 first slice: Tier 2 DOM inspection bridge. The bootstrap bridge
   runs in an isolated stand-in realm (the ws-shim pattern for ws.ts);
   the engine half runs against a fake SW global with a scripted
   bridge client over real MessageChannel ports. The control-plane
   stubs mirror captcha-trace.test.ts so control.ts can collect
   without the CI-generated wasm glue. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () =>
      new Response("mock", { headers: { "content-type": "text/plain" } }),
  },
  altConfigured: () => false,
  altRegister: () => {},
  altEndpoint: () => null,
  altWispFetch: async () => {
    throw new Error("no alt transport in test");
  },
  canReplayAfterFailure: () => false,
}));

vi.mock("../ws-runtime", () => ({
  wsBridge: {
    open: () => {},
    closeAll: () => {},
  },
}));

vi.mock("../transform", () => ({
  initTransform: () => {},
  prewarmRewriter: async () => {},
  rewriter: async () => {
    throw new Error("no rewriter in test");
  },
  workerPrelude: async () => "",
  isHtml: (resp: Response) => (resp.headers.get("content-type") ?? "").includes("text/html"),
  isCss: (resp: Response) => (resp.headers.get("content-type") ?? "").includes("text/css"),
  isJs: (resp: Response) => {
    const ct = resp.headers.get("content-type") ?? "";
    return ct.includes("javascript") || ct.includes("ecmascript");
  },
  JS_BODY_CAP: 2 * 1024 * 1024,
  rawFrom: (_head: unknown, reader: ReadableStreamDefaultReader<Uint8Array>) =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) c.enqueue(value);
        }
        c.close();
      },
    }),
  rewriteStream: (body: ReadableStream<Uint8Array>) => body,
  cssRewriteStream: (body: ReadableStream<Uint8Array>) => body,
  rewriteJsBody: async (js: string) => js,
  boundedBody: async (body: ReadableStream<Uint8Array> | null) => ({
    over: false, head: null, rest: null, bytes: new Uint8Array(0), body,
  }),
  passthroughStream: (head: Uint8Array | null, h: Uint8Array | null, rest: ReadableStream<Uint8Array> | null) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (head) c.enqueue(head);
        if (h) c.enqueue(h);
        void rest;
        c.close();
      },
    }),
  scriptPinsOrigins: async () => false,
}));

import { applyDomInspect } from "../dominspect-core";
import {
  domInspectAuthorize,
  domInspectRequest,
  domInspectResetForTests,
  domInspectRevoke,
} from "../dom-inspect";
import { CORE_CONTROL_TYPES, handleControlEvent, type ControlMessage } from "../control";
import { privacyResetForTests } from "../privacy";

const ORIGIN = "https://w.example.org";

/* ---- stand-in realm for the bootstrap bridge ----------------------- */

interface FakeEl {
  tagName: string;
  id?: string;
  className?: string;
  attributes: Array<{ name: string; value: string }>;
  children: FakeEl[];
}

function el(tag: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  const node: FakeEl = { tagName: tag, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), children };
  if (attrs.id !== undefined) node.id = attrs.id;
  if (attrs.class !== undefined) node.className = attrs.class;
  const hook = node as unknown as Record<string, unknown>;
  hook.appendChild = (c: unknown): void => { (c as Record<string, unknown>).parentNode = node; };
  hook.removeChild = (c: unknown): void => { (c as Record<string, unknown>).parentNode = null; };
  return node;
}

interface Realm {
  controller: unknown;
  listeners: Array<(ev: MessageEvent) => void>;
  dispatch: (msg: unknown, ports?: MessagePort[], from?: unknown) => void;
  consoleObj: Record<string, unknown>;
  setRoot: (root: FakeEl | null) => void;
  setStyles: (props: Array<[string, string]>) => void;
  divs: Array<Record<string, unknown>>;
  local: Map<string, string>;
  session: Map<string, string>;
  w: Record<string, unknown>;
}

function makeRealm(): Realm {
  const listeners: Array<(ev: MessageEvent) => void> = [];
  const controller = { id: "ctl" };
  const consoleObj: Record<string, unknown> = {
    log: () => {},
    warn: () => {},
    error: () => {},
    info: () => {},
  };
  let root: FakeEl | null = null;
  let styles: Array<[string, string]> = [];
  const divs: Array<Record<string, unknown>> = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const makeDiv = (): Record<string, unknown> => {
    const div: Record<string, unknown> = {
      attrs: {} as Record<string, string>,
      style: {} as Record<string, string>,
      parentNode: null,
    };
    div.setAttribute = (n: string, v: string): void => { (div.attrs as Record<string, string>)[n] = v; };
    div.appendChild = (c: unknown): void => { (c as Record<string, unknown>).parentNode = div; };
    div.removeChild = (c: unknown): void => { (c as Record<string, unknown>).parentNode = null; };
    div.remove = (): void => { div.parentNode = null; };
    divs.push(div);
    return div;
  };
  const storeOf = (m: Map<string, string>): Record<string, unknown> => ({
    get length() { return m.size; },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
  });
  const w: Record<string, unknown> = {
    navigator: {
      serviceWorker: {
        controller,
        addEventListener: (_t: string, f: (ev: MessageEvent) => void) => {
          listeners.push(f);
        },
      },
    },
    console: consoleObj,
    document: {
      get documentElement() {
        return root;
      },
      get cookie(): string {
        /* Oracle: the storage view must never read document.cookie. */
        throw new Error("cookie read attempted");
      },
      createElement: () => makeDiv(),
    },
    localStorage: storeOf(local),
    sessionStorage: storeOf(session),
    getComputedStyle: (n: unknown) => {
      void n;
      return {
        length: styles.length,
        item: (k: number) => styles[k][0],
        getPropertyValue: (name: string) => styles.find(([k]) => k === name)?.[1] ?? "",
      };
    },
  };
  applyDomInspect(w);
  return {
    controller,
    listeners,
    dispatch: (msg, ports = [], from) => {
      const ev = {
        source: from === undefined ? controller : from,
        data: msg,
        ports,
      } as unknown as MessageEvent;
      for (const f of listeners) f(ev);
    },
    consoleObj,
    setRoot: (r) => {
      root = r;
    },
    setStyles: (s) => {
      styles = s;
    },
    divs,
    local,
    session,
    w,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("bootstrap DOM bridge (#550)", () => {
  it("refuses inspection requests before authorization", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML", {}, [el("DIV")]));
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "snapshot" }, [mc.port2]);
    await sleep(20);
    expect(replies).toEqual([]);
  });

  it("ignores messages that do not come from the controller", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, [mc.port2], { id: "not-the-controller" });
    await sleep(20);
    expect(replies).toEqual([]);
  });

  it("authorize activates the console patch and replies with the generation", async () => {
    const realm = makeRealm();
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    const originalLog = realm.consoleObj.log;
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, [mc.port2]);
    await sleep(20);
    expect(replies).toEqual([{ ok: true, gen: expect.any(Number) }]);
    expect(realm.consoleObj.log).not.toBe(originalLog);
  });

  it("console capture bounds, redacts and flattens; revoke restores", async () => {
    const realm = makeRealm();
    const originalLog = realm.consoleObj.log;
    const ctl = new MessageChannel();
    const ctlReplies: unknown[] = [];
    ctl.port1.onmessage = (ev) => ctlReplies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, [ctl.port2]);
    await sleep(20);
    expect(ctlReplies).toEqual([{ ok: true, gen: expect.any(Number) }]);
    const consoleLog = realm.consoleObj.log as (...a: unknown[]) => void;
    consoleLog("visit https://x.example/?access_token=LEAK1", { constructor: { name: "Error" } });
    consoleLog("a", "b", "c", "d", "e", "f", "g", "h", "nine");
    consoleLog("x".repeat(600));
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "console" }, [mc.port2]);
    await sleep(20);
    const consoleReply = replies[0] as {
      ok: boolean;
      entries: Array<{ level: string; args: string[] }>;
      dropped: number;
    };
    expect(consoleReply.ok).toBe(true);
    expect(consoleReply.entries.length).toBe(3);
    expect(consoleReply.entries[0]!.args[0]).toContain("access_token=[redacted]");
    expect(consoleReply.entries[0]!.args[1]).toBe("[object Error]");
    expect(consoleReply.entries[1]!.args.length).toBe(8);
    expect(consoleReply.entries[2]!.args[0]!.length).toBe(500);
    /* Revoke: the page's own console returns and the ring is gone. */
    realm.dispatch({ type: "zl:domInspectCtl", on: false }, []);
    await sleep(20);
    expect(realm.consoleObj.log).toBe(originalLog);
    const after = new MessageChannel();
    const afterReplies: unknown[] = [];
    after.port1.onmessage = (ev) => afterReplies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "console" }, [after.port2]);
    await sleep(20);
    expect(afterReplies).toEqual([]);
  });

  it("console ring keeps the newest 128 entries and counts drops", async () => {
    const realm = makeRealm();
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await sleep(20);
    const consoleLog = realm.consoleObj.log as (...a: unknown[]) => void;
    for (let i = 0; i < 130; i++) consoleLog("e" + i);
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "console" }, [mc.port2]);
    await sleep(20);
    const r = replies[0] as { entries: Array<{ args: string[] }>; dropped: number };
    expect(r.entries.length).toBe(128);
    expect(r.dropped).toBe(2);
    expect(r.entries[0]!.args[0]).toBe("e2");
    expect(r.entries[127]!.args[0]).toBe("e129");
  });

  it("snapshot bounds depth and node count with honest truncation", async () => {
    const realm = makeRealm();
    /* A 20-deep chain under the root (depth beyond 12 truncated). */
    let deep: FakeEl = el("LEAF");
    for (let i = 0; i < 20; i++) deep = el("L" + i, {}, [deep]);
    /* 600 siblings: the 500-node cap truncates. */
    const wide = el("WIDE", {}, Array.from({ length: 600 }, (_, i) => el("S" + i)));
    realm.setRoot(el("HTML", {}, [deep, wide]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await sleep(20);
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "snapshot" }, [mc.port2]);
    await sleep(20);
    const r = replies[0] as {
      ok: boolean;
      tree: { children: Array<{ children?: unknown[]; truncated?: boolean }> };
      truncated: boolean;
      nodes: number;
    };
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.nodes).toBe(500);
    /* The deep chain stops at depth 12: the truncation marker rides a node. */
    let depth = 0;
    let n: unknown = r.tree;
    let sawTruncationMarker = false;
    while (n && typeof n === "object" && depth < 30) {
      const node = n as { truncated?: boolean; children?: unknown[] };
      if (!node.children || node.children.length === 0) break;
      n = node.children[0];
      depth++;
      if ((n as { truncated?: boolean })?.truncated || node.truncated) {
        sawTruncationMarker = true;
        break;
      }
    }
    expect(depth).toBeLessThanOrEqual(13);
    expect(sawTruncationMarker).toBe(true);
  });

  it("never serializes input values, not even by reading .value", async () => {
    const realm = makeRealm();
    const input = el("INPUT", { value: "SECRET-VALUE", type: "password" });
    /* A poisoned .value property read anywhere would throw. */
    Object.defineProperty(input, "value", {
      get() {
        throw new Error("input .value was read");
      },
    });
    realm.setRoot(el("HTML", {}, [input]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await sleep(20);
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "snapshot" }, [mc.port2]);
    await sleep(20);
    const r = replies[0] as { ok: boolean; tree: { children: Array<{ attrs?: Record<string, string>; tag: string }> } };
    expect(r.ok).toBe(true);
    const inputNode = r.tree.children[0]!;
    expect(inputNode.tag).toBe("INPUT");
    expect(inputNode.attrs?.value).toBeUndefined();
    expect(inputNode.attrs?.type).toBe("password");
  });

  it("computed styles cap at 64 properties", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    realm.setStyles(Array.from({ length: 100 }, (_, i) => ["prop-" + i, "v" + i] as [string, string]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await sleep(20);
    const snap = new MessageChannel();
    const snapReplies: unknown[] = [];
    snap.port1.onmessage = (ev) => snapReplies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "snapshot" }, [snap.port2]);
    await sleep(20);
    expect((snapReplies[0] as { ok: boolean }).ok).toBe(true);
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "styles", nodeId: 0 }, [mc.port2]);
    await sleep(20);
    const r = replies[0] as { ok: boolean; styles: Array<[string, string]> };
    expect(r.ok).toBe(true);
    expect(r.styles.length).toBe(64);
    expect(r.styles[0]).toEqual(["prop-0", "v0"]);
    /* Unknown node index fails honestly. */
    const mc2 = new MessageChannel();
    const replies2: unknown[] = [];
    mc2.port1.onmessage = (ev) => replies2.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "styles", nodeId: 999 }, [mc2.port2]);
    await sleep(20);
    expect(replies2[0]).toMatchObject({ ok: false, error: "no such snapshot node" });
  });
});

/* ---- the engine half ----------------------------------------------- */

let clientsGet: ReturnType<typeof vi.fn>;

const FAKE_GEN = 1_700_000_123_456;

/** A fake proxied client whose bridge replies with `script.reply`'s
    data over the real transferred port. */
function fakeBridgeClient(
  reply: (msg: Record<string, unknown>) => Record<string, unknown> | null,
): { client: Client; posts: Array<Record<string, unknown>> } {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    url: ORIGIN + "/j/someRoute",
    postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => {
      posts.push(msg);
      const port2 = (transfer ?? []).find((t) => t instanceof MessagePort) as MessagePort | undefined;
      if (!port2) return;
      const answer = reply(msg);
      if (answer) setTimeout(() => port2.postMessage(answer), 0);
    },
  } as unknown as Client;
  return { client, posts };
}

describe("engine half: sessions and relay (#550)", () => {
  beforeEach(() => {
    domInspectResetForTests();
    clientsGet = vi.fn(async (_id: string) => null);
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      clients: { get: clientsGet },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("BRIDGE-SOURCE", { status: 200 })));
  });

  afterEach(() => {
    domInspectResetForTests();
    vi.unstubAllGlobals();
  });

  it("authorize pins the bridge generation; requests relay and redact", async () => {
    const { client } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      if (msg.op === "snapshot") {
        return { ok: true, gen: FAKE_GEN, tree: { tag: "HTML", children: [] }, nodes: 1, note: "token=LEAK9" };
      }
      return null;
    });
    clientsGet.mockResolvedValue(client);
    expect(await domInspectAuthorize("client-a")).toEqual({ ok: true, gen: FAKE_GEN });
    const snap = await domInspectRequest("client-a", "snapshot");
    expect(snap.ok).toBe(true);
    expect(snap.gen).toBe(FAKE_GEN);
    /* The authoritative redactSecrets pass ran engine-side. */
    expect(JSON.stringify(snap)).not.toContain("LEAK9");
    expect(JSON.stringify(snap)).toContain("[redacted]");
  });

  it("a request without an authorized session refuses and never contacts the client", async () => {
    const { client, posts } = fakeBridgeClient(() => null);
    clientsGet.mockResolvedValue(client);
    const r = await domInspectRequest("client-b", "snapshot");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no inspection session for clientId");
    expect(posts).toEqual([]);
  });

  it("a stale generation (later document) is discarded and kills the session", async () => {
    const { client } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      /* The document navigated: a new realm answers with a new gen. */
      return { ok: true, gen: FAKE_GEN + 1, tree: { tag: "HTML" } };
    });
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("client-c");
    const r = await domInspectRequest("client-c", "snapshot");
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    /* The session died with the stale reply. */
    const r2 = await domInspectRequest("client-c", "snapshot");
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("no inspection session for clientId");
  });

  it("the authorize message carries the compiled bridge source", async () => {
    const { client, posts } = fakeBridgeClient((msg) =>
      msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null,
    );
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("code-1");
    expect(posts[0]).toMatchObject({ type: "zl:domInspectCtl", on: true, code: "BRIDGE-SOURCE" });
  });

  it("authorize fails honestly when the inspector bundle is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, posts } = fakeBridgeClient(() => null);
    clientsGet.mockResolvedValue(client);
    const r = await domInspectAuthorize("nobundle-1", 30);
    expect(r).toEqual({ ok: false, error: "inspector bundle unavailable" });
    expect(posts).toEqual([]);
  });

  it("authorize refuses host-page targets and dead clients", async () => {
    const hostPage = { url: ORIGIN + "/devtools.html", postMessage: () => {} } as unknown as Client;
    clientsGet.mockResolvedValue(hostPage);
    expect(await domInspectAuthorize("host-1")).toEqual({ ok: false, error: "no live proxied client for clientId" });
    clientsGet.mockResolvedValue(null);
    expect(await domInspectAuthorize("gone-1")).toEqual({ ok: false, error: "no live proxied client for clientId" });
  });

  it("authorize fails honestly when no bridge answers", async () => {
    const { client, posts } = fakeBridgeClient(() => null);
    clientsGet.mockResolvedValue(client);
    const r = await domInspectAuthorize("silent-1", 30);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bridge did not answer the authorize handshake");
    expect(posts.length).toBe(1);
  });

  it("a bridge error reply forwards the error; a client death reports it", async () => {
    const bridgeError = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      return { ok: false, gen: FAKE_GEN, error: "no document" };
    });
    clientsGet.mockResolvedValue(bridgeError.client);
    await domInspectAuthorize("err-1");
    expect(await domInspectRequest("err-1", "snapshot")).toEqual({ ok: false, error: "no document" });

    clientsGet.mockResolvedValue(null);
    const gone = await domInspectRequest("err-1", "snapshot");
    expect(gone.ok).toBe(false);
    expect(gone.error).toBe("client is gone (navigation closed it)");
  });

  it("revoke drops the session and tells the bridge to tear down", async () => {
    const { client, posts } = fakeBridgeClient((msg) =>
      msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null,
    );
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("rev-1");
    expect(domInspectRevoke("rev-1")).toBe(true);
    expect(domInspectRevoke("rev-1")).toBe(false);
    await sleep(10);
    const ctlOff = posts.find((p) => p.type === "zl:domInspectCtl" && p.on === false);
    expect(ctlOff).toBeTruthy();
    expect((await domInspectRequest("rev-1", "snapshot")).ok).toBe(false);
  });
});

/* ---- control plane -------------------------------------------------- */

describe("zl:domInspect control message (#550)", () => {
  const mkMsgEvent = (sourceUrl: string, msg: ControlMessage) => {
    const posted: unknown[] = [];
    const waiters: Array<Promise<unknown>> = [];
    const ev = {
      data: msg,
      ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
      source: { url: sourceUrl, id: "c1" },
      waitUntil: (p: Promise<unknown>) => waiters.push(p),
    } as unknown as ExtendableMessageEvent;
    return { ev, posted, waiters };
  };
  const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

  beforeEach(() => {
    domInspectResetForTests();
    clientsGet = vi.fn(async (_id: string) => null);
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      clients: { get: clientsGet },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("BRIDGE-SOURCE", { status: 200 })));
  });
  afterEach(() => {
    domInspectResetForTests();
    vi.unstubAllGlobals();
  });

  it("the type is registered in CORE_CONTROL_TYPES with the dispatch", () => {
    expect(CORE_CONTROL_TYPES.has("zl:domInspect")).toBe(true);
  });

  it("refuses a proxied-page sender (host pages only)", async () => {
    const { ev, posted } = mkMsgEvent(ORIGIN + "/j/route", {
      type: "zl:domInspect", op: "authorize", clientId: "x",
    });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });

  it("answers a host sender's authorize through the relay", async () => {
    const { client } = fakeBridgeClient((msg) =>
      msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null,
    );
    clientsGet.mockResolvedValue(client);
    const { ev, posted, waiters } = mkMsgEvent(ORIGIN + "/devtools.html", {
      type: "zl:domInspect", op: "authorize", clientId: "ctl-1",
    });
    await handleControlEvent(ev, deps);
    await Promise.all(waiters);
    expect(posted).toEqual([{ ok: true, gen: FAKE_GEN }]);
  });

  it("rejects malformed ops and missing clientIds", async () => {
    const noClient = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "snapshot" });
    await handleControlEvent(noClient.ev, deps);
    expect(noClient.posted).toEqual([{ ok: false, error: "bad zl:domInspect clientId" }]);
    clientsGet.mockResolvedValue(null);
    const badOp = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "unknown" as "snapshot", clientId: "x" });
    await handleControlEvent(badOp.ev, deps);
    await Promise.all(badOp.waiters);
    expect(badOp.posted).toEqual([{ ok: false, error: "bad zl:domInspect op" }]);
  });

  it("relays snapshot for a host sender with an authorized session", async () => {
    const { client } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      if (msg.op === "snapshot") return { ok: true, gen: FAKE_GEN, tree: { tag: "HTML", children: [] }, nodes: 1 };
      return null;
    });
    clientsGet.mockResolvedValue(client);
    const auth = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "authorize", clientId: "ctl-2" });
    await handleControlEvent(auth.ev, deps);
    await Promise.all(auth.waiters);
    const snap = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "snapshot", clientId: "ctl-2" });
    await handleControlEvent(snap.ev, deps);
    await Promise.all(snap.waiters);
    expect(snap.posted[0]).toMatchObject({ ok: true, gen: FAKE_GEN, nodes: 1 });
  });

  it("relays the storage grant on the authorize handshake (#550 ship 2)", async () => {
    const { client, posts } = fakeBridgeClient((msg) =>
      msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null,
    );
    clientsGet.mockResolvedValue(client);
    const auth = mkMsgEvent(ORIGIN + "/", {
      type: "zl:domInspect",
      op: "authorize",
      clientId: "ctl-s",
      storage: true,
    });
    await handleControlEvent(auth.ev, deps);
    await Promise.all(auth.waiters);
    expect(auth.posted[0]).toEqual({ ok: true, gen: FAKE_GEN });
    expect(posts[0]).toMatchObject({ type: "zl:domInspectCtl", storage: true });
  });
});


/* ---- ship 2: highlight overlay (#550) ------------------------------ */

describe("bridge highlight overlay (#550 ship 2)", () => {
  const ask = (
    realm: ReturnType<typeof makeRealm>,
    msg: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const mc = new MessageChannel();
    return new Promise((res) => {
      mc.port1.onmessage = (ev) => res(ev.data as Record<string, unknown>);
      realm.dispatch(msg, [mc.port2]);
    });
  };
  type Rect = () => { left: number; top: number; width: number; height: number };
  const withRect = (n: FakeEl, r: Rect): void => {
    (n as unknown as { getBoundingClientRect: Rect }).getBoundingClientRect = r;
  };

  it("refuses highlight before a snapshot pinned any node", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML", {}, [el("DIV")]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 1 });
    expect(reply).toMatchObject({ ok: false, error: "no such snapshot node" });
    expect(realm.divs).toEqual([]);
  });

  it("creates a CSSOM-only overlay pinned to the snapshot node rect", async () => {
    const realm = makeRealm();
    const mark = el("DIV", { id: "mark" });
    withRect(mark, () => ({ left: 5.4, top: 6.6, width: 30.2, height: 12.9 }));
    realm.setRoot(el("HTML", {}, [mark]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    const snap = await ask(realm, { type: "zl:domInspectReq", op: "snapshot" });
    expect(snap).toMatchObject({ ok: true, nodes: 2 });
    const hl = await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 1 });
    expect(hl).toMatchObject({ ok: true });
    expect(realm.divs).toHaveLength(1);
    const div = realm.divs[0];
    /* CSSOM only: the data attribute is the single setAttribute call,
       never a style attribute a page CSP could block. */
    expect(Object.keys(div.attrs as Record<string, string>)).toEqual(["data-zl-di-hl"]);
    const style = div.style as Record<string, string>;
    expect(style.position).toBe("fixed");
    expect(style.left).toBe("5px");
    expect(style.top).toBe("7px");
    expect(style.width).toBe("30px");
    expect(style.height).toBe("13px");
    expect(style.pointerEvents).toBe("none");
    expect(style.zIndex).toBe("2147483647");
    expect((div.parentNode as { tagName?: string }).tagName).toBe("HTML");
  });

  it("replaces the overlay, clears it without a nodeId, and revoke tears it down", async () => {
    const realm = makeRealm();
    const mark = el("DIV", { id: "mark" });
    const other = el("SPAN", { id: "other" });
    withRect(mark, () => ({ left: 1, top: 2, width: 3, height: 4 }));
    withRect(other, () => ({ left: 9, top: 9, width: 9, height: 9 }));
    realm.setRoot(el("HTML", {}, [mark, other]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await ask(realm, { type: "zl:domInspectReq", op: "snapshot" });
    expect((await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 1 })).ok).toBe(true);
    const first = realm.divs[0];
    expect(first.parentNode).toBeTruthy();
    expect((await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 2 })).ok).toBe(true);
    expect(first.parentNode).toBeNull();
    expect(realm.divs).toHaveLength(2);
    expect((await ask(realm, { type: "zl:domInspectReq", op: "highlight" })).ok).toBe(true);
    expect(realm.divs.every((d) => d.parentNode === null)).toBe(true);
    expect((await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 1 })).ok).toBe(true);
    realm.dispatch({ type: "zl:domInspectCtl", on: false }, []);
    expect(realm.divs.every((d) => d.parentNode === null)).toBe(true);
    /* after teardown the session is closed: no more requests answer */
    const mc = new MessageChannel();
    const replies: unknown[] = [];
    mc.port1.onmessage = (ev) => replies.push(ev.data);
    realm.dispatch({ type: "zl:domInspectReq", op: "highlight", nodeId: 1 }, [mc.port2]);
    await sleep(20);
    expect(replies).toEqual([]);
  });

  it("refuses a bad nodeId and a node with no rect", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML", {}, [el("DIV")]));
    realm.dispatch({ type: "zl:domInspectCtl", on: true }, []);
    await ask(realm, { type: "zl:domInspectReq", op: "snapshot" });
    expect(await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 999 })).toMatchObject({
      ok: false,
      error: "no such snapshot node",
    });
    /* node 0 is the root, which has no getBoundingClientRect at all */
    expect(await ask(realm, { type: "zl:domInspectReq", op: "highlight", nodeId: 0 })).toMatchObject({
      ok: false,
      error: "no such snapshot node",
    });
  });
});

/* ---- ship 2: the storage view (#550) -------------------------------- */

describe("bridge storage view (#550 ship 2)", () => {
  const ask = (
    realm: ReturnType<typeof makeRealm>,
    msg: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const mc = new MessageChannel();
    return new Promise((res) => {
      mc.port1.onmessage = (ev) => res(ev.data as Record<string, unknown>);
      realm.dispatch(msg, [mc.port2]);
    });
  };
  interface StorageView {
    entries: Array<{ k: string; v: string }>;
    truncated: boolean;
    unavailable: boolean;
  }
  const view = (reply: Record<string, unknown>, name: string): StorageView => reply[name] as StorageView;

  it("refuses the storage op unless the authorize carried storage:true", async () => {
    const realm = makeRealm();
    realm.local.set("k", "v");
    realm.setRoot(el("HTML"));
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: false }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    expect(reply).toMatchObject({ ok: false, error: "storage view not granted" });
  });

  it("returns page-realm stores only: capped, redacted, cookie never read", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    /* the oracle: makeRealm w.document.cookie is a throwing getter, so
       this test fails the moment any code path reads document.cookie */
    realm.local.set("auth", "token=supersecret");
    realm.local.set("k".repeat(200), "x");
    for (let i = 0; i < 200; i++) realm.local.set("key-" + i, "v" + i);
    realm.session.set("s1", "sessionval");
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    expect(reply.ok).toBe(true);
    const local = view(reply, "local");
    expect(local.unavailable).toBe(false);
    expect(local.entries).toHaveLength(128);
    expect(local.truncated).toBe(true);
    expect(local.entries[0]).toEqual({ k: "auth", v: "token=[redacted]" });
    /* the view SORTS (#550 follow-up): the facade enumerates in hash
       order, so the capped window is deterministic, ascending, and
       the lexicographic key order puts key-0 and key-1 right after
       auth while the 200-char k-key sorts last, outside the cap */
    expect(local.entries[1]).toEqual({ k: "key-0", v: "v0" });
    expect(local.entries[2]).toEqual({ k: "key-1", v: "v1" });
    expect(local.entries[3]).toEqual({ k: "key-10", v: "v10" });
    expect(local.entries).toHaveLength(128);
    for (const e of local.entries) expect(e.k.length).toBeLessThan(128);
    const session = view(reply, "session");
    expect(session).toMatchObject({ unavailable: false, truncated: false });
    expect(session.entries).toEqual([{ k: "s1", v: "sessionval" }]);
  });

  it("reports a throwing store as unavailable, never guessed", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    (realm.w as Record<string, unknown>).localStorage = {
      length: 5,
      key: () => {
        throw new Error("store disabled");
      },
      getItem: () => "",
    };
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    expect(reply.ok).toBe(true);
    expect(view(reply, "local")).toMatchObject({ unavailable: true, truncated: false, entries: [] });
    expect(view(reply, "session").unavailable).toBe(false);
  });

  it("sorts the capped view so a hash-ordered facade cannot change it (#550 follow-up)", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    /* the live defect, replayed: key(i) returns hash order, not
       insertion order (observed on real Chromium as zl-di-key-20,
       115, 82, 97, 197 with the first-written auth entry lost from
       the cap), so the view must not be order-faithful */
    const scrambled = [
      "zl-di-key-20", "zl-di-auth", "zl-di-key-115", "zl-di-key-82",
      "zl-di-key-97", "zl-di-key-197",
    ];
    for (let i = 0; i < 300; i++) scrambled.push("zl-di-key-" + i);
    const backing = new Map<string, string>();
    for (const k of scrambled) backing.set(k, "v-" + k);
    (realm.w as Record<string, unknown>).localStorage = {
      get length() {
        return scrambled.length;
      },
      key: (i: number) => scrambled[i] ?? null,
      getItem: (k: string) => backing.get(k) ?? null,
    };
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    const local = view(reply, "local");
    expect(local.unavailable).toBe(false);
    expect(local.entries).toHaveLength(128);
    expect(local.truncated).toBe(true);
    expect(local.entries[0].k).toBe("zl-di-auth");
    const ks = local.entries.map((e) => e.k);
    expect(ks).toEqual([...ks].sort());
  });

  it("keeps the value of an over-length key via the raw lookup (#550 follow-up)", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    realm.local.set("k".repeat(200), "x");
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    const local = view(reply, "local");
    expect(local.entries).toHaveLength(1);
    expect(local.entries[0].k).toHaveLength(128);
    expect(local.entries[0].v).toBe("x");
  });

  it("caps values at 500 characters", async () => {
    const realm = makeRealm();
    realm.setRoot(el("HTML"));
    realm.local.set("big", "z".repeat(900));
    realm.dispatch({ type: "zl:domInspectCtl", on: true, storage: true }, []);
    const reply = await ask(realm, { type: "zl:domInspectReq", op: "storage" });
    const local = view(reply, "local");
    expect(local.entries[0].k).toBe("big");
    expect(local.entries[0].v).toBe("z".repeat(500));
  });
});

/* ---- ship 2: the storage grant and highlight relay (engine) --------- */

describe("engine half: storage grant and highlight relay (#550 ship 2)", () => {
  beforeEach(() => {
    domInspectResetForTests();
    clientsGet = vi.fn(async (_id: string) => null);
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      clients: { get: clientsGet },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("BRIDGE-SOURCE", { status: 200 })));
  });
  afterEach(() => {
    domInspectResetForTests();
    vi.unstubAllGlobals();
  });

  it("authorize carries the storage grant in the handshake", async () => {
    const granted = fakeBridgeClient(() => ({ ok: true, gen: FAKE_GEN }));
    clientsGet.mockResolvedValue(granted.client);
    expect(await domInspectAuthorize("g-1", 3000, { storage: true })).toEqual({ ok: true, gen: FAKE_GEN });
    expect(granted.posts.find((p) => p.type === "zl:domInspectCtl")).toMatchObject({
      on: true,
      ctl: true,
      storage: true,
    });
    const bare = fakeBridgeClient(() => ({ ok: true, gen: FAKE_GEN }));
    clientsGet.mockResolvedValue(bare.client);
    await domInspectAuthorize("g-2");
    expect(bare.posts.find((p) => p.type === "zl:domInspectCtl")).toMatchObject({
      on: true,
      ctl: true,
      storage: false,
    });
  });

  it("refuses storage without the grant and never contacts the client", async () => {
    const { client, posts } = fakeBridgeClient(() => ({ ok: true, gen: FAKE_GEN }));
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("n-1");
    const before = posts.length;
    expect(await domInspectRequest("n-1", "storage")).toEqual({
      ok: false,
      error: "storage view not granted for this session",
    });
    expect(posts.length).toBe(before);
  });

  it("relays storage with the grant and re-redacts the reply", async () => {
    const { client } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      if (msg.op === "storage") {
        return {
          ok: true,
          gen: FAKE_GEN,
          local: { entries: [{ k: "a", v: "token=LEAK9" }], truncated: false, unavailable: false },
          session: { entries: [], truncated: false, unavailable: false },
        };
      }
      return null;
    });
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("s-1", 3000, { storage: true });
    const reply = await domInspectRequest("s-1", "storage");
    expect(reply.ok).toBe(true);
    const local = reply.local as { entries: Array<{ k: string; v: string }> };
    expect(local.entries[0].v).toBe("token=[redacted]");
  });

  it("refuses a bridge storage reply over the entry cap", async () => {
    const over = Array.from({ length: 200 }, (_, i) => ({ k: "k" + i, v: "" }));
    const { client } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      if (msg.op === "storage") {
        return {
          ok: true,
          gen: FAKE_GEN,
          local: { entries: over, truncated: false, unavailable: false },
          session: { entries: [], truncated: false, unavailable: false },
        };
      }
      return null;
    });
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("o-1", 3000, { storage: true });
    expect(await domInspectRequest("o-1", "storage")).toEqual({
      ok: false,
      error: "bridge storage reply over cap",
    });
  });

  it("relays highlight nodeIds and a clear without one", async () => {
    const { client, posts } = fakeBridgeClient((msg) => {
      if (msg.type === "zl:domInspectCtl") return { ok: true, gen: FAKE_GEN };
      if (msg.op === "highlight") return { ok: true, gen: FAKE_GEN };
      return null;
    });
    clientsGet.mockResolvedValue(client);
    await domInspectAuthorize("h-1");
    expect((await domInspectRequest("h-1", "highlight", 7)).ok).toBe(true);
    expect((await domInspectRequest("h-1", "highlight")).ok).toBe(true);
    const relays = posts.filter((p) => p.op === "highlight");
    expect(relays).toHaveLength(2);
    expect(relays[0]).toMatchObject({ op: "highlight", nodeId: 7 });
    expect((relays[1] as { nodeId?: unknown }).nodeId).toBeUndefined();
  });
});

/* ---- ship 2: strict privacy mode (#550) ----------------------------- */

describe("zl:privacy strict mode (#550 ship 2)", () => {
  const mkMsgEvent = (sourceUrl: string, msg: ControlMessage) => {
    const posted: unknown[] = [];
    const waiters: Array<Promise<unknown>> = [];
    const ev = {
      data: msg,
      ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
      source: { url: sourceUrl, id: "c1" },
      waitUntil: (p: Promise<unknown>) => waiters.push(p),
    } as unknown as ExtendableMessageEvent;
    return { ev, posted, waiters };
  };
  const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

  beforeEach(() => {
    privacyResetForTests();
    domInspectResetForTests();
    clientsGet = vi.fn(async (_id: string) => null);
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      clients: { get: clientsGet },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("BRIDGE-SOURCE", { status: 200 })));
  });
  afterEach(() => {
    privacyResetForTests();
    domInspectResetForTests();
    vi.unstubAllGlobals();
  });

  it("registers zl:privacy in CORE_CONTROL_TYPES", () => {
    expect(CORE_CONTROL_TYPES.has("zl:privacy")).toBe(true);
  });

  it("refuses a proxied-page sender (host pages only)", async () => {
    const { ev, posted } = mkMsgEvent(ORIGIN + "/j/route", { type: "zl:privacy", strict: true });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });

  it("toggles strict from a host sender and refuses the five surfaces", async () => {
    const on = mkMsgEvent(ORIGIN + "/", { type: "zl:privacy", strict: true });
    await handleControlEvent(on.ev, deps);
    expect(on.posted).toEqual([{ ok: true, strict: true }]);
    const surfaces = [
      { type: "zl:domInspect", op: "authorize", clientId: "x" },
      { type: "zl:getNetLog", since: 0 },
      { type: "zl:getDiag" },
      { type: "zl:exportDiagnostics" },
      { type: "zl:captchaTrace" },
    ] as ControlMessage[];
    for (const surface of surfaces) {
      const { ev, posted } = mkMsgEvent(ORIGIN + "/", surface);
      await handleControlEvent(ev, deps);
      expect(posted).toEqual([{ ok: false, error: "strict privacy mode: diagnostic surface refused" }]);
    }
    /* the toggle itself still answers under strict mode */
    const off = mkMsgEvent(ORIGIN + "/", { type: "zl:privacy", strict: false });
    await handleControlEvent(off.ev, deps);
    expect(off.posted).toEqual([{ ok: true, strict: false }]);
  });

  it("leaves the mode when strict is off: the inspector answers again", async () => {
    await handleControlEvent(mkMsgEvent(ORIGIN + "/", { type: "zl:privacy", strict: true }).ev, deps);
    const refused = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "authorize", clientId: "r-1" });
    await handleControlEvent(refused.ev, deps);
    expect(refused.posted[0]).toMatchObject({ ok: false, error: "strict privacy mode: diagnostic surface refused" });
    await handleControlEvent(mkMsgEvent(ORIGIN + "/", { type: "zl:privacy", strict: false }).ev, deps);
    const { client } = fakeBridgeClient((msg) => (msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null));
    clientsGet.mockResolvedValue(client);
    const auth = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "authorize", clientId: "r-1" });
    await handleControlEvent(auth.ev, deps);
    await Promise.all(auth.waiters);
    expect(auth.posted[0]).toEqual({ ok: true, gen: FAKE_GEN });
  });

  it("is memory-only: the reset clears it for the next session", async () => {
    await handleControlEvent(mkMsgEvent(ORIGIN + "/", { type: "zl:privacy", strict: true }).ev, deps);
    privacyResetForTests();
    const { client } = fakeBridgeClient((msg) => (msg.type === "zl:domInspectCtl" ? { ok: true, gen: FAKE_GEN } : null));
    clientsGet.mockResolvedValue(client);
    const auth = mkMsgEvent(ORIGIN + "/", { type: "zl:domInspect", op: "authorize", clientId: "m-1" });
    await handleControlEvent(auth.ev, deps);
    await Promise.all(auth.waiters);
    expect(auth.posted[0]).toEqual({ ok: true, gen: FAKE_GEN });
  });
});
