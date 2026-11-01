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

import { applyDomInspect } from "../bootstrap/dominspect";
import {
  domInspectAuthorize,
  domInspectRequest,
  domInspectResetForTests,
  domInspectRevoke,
} from "../dom-inspect";
import { CORE_CONTROL_TYPES, handleControlEvent, type ControlMessage } from "../control";

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
  return node;
}

interface Realm {
  controller: unknown;
  listeners: Array<(ev: MessageEvent) => void>;
  dispatch: (msg: unknown, ports?: MessagePort[], from?: unknown) => void;
  consoleObj: Record<string, unknown>;
  setRoot: (root: FakeEl | null) => void;
  setStyles: (props: Array<[string, string]>) => void;
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
    },
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
      location: { origin: ORIGIN },
      clients: { get: clientsGet },
    };
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
      location: { origin: ORIGIN },
      clients: { get: clientsGet },
    };
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
});
