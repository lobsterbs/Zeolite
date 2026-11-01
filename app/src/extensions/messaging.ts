/* Zeolite extension subsystem: message passing.

   Channels are strictly per-extension. Every message names its target
   extension id and the router refuses delivery to any other extension
   unless the target's externally_connectable.ids admit the sender
   (#518): allowed cross-extension traffic goes to the target's
   onMessageExternal / onConnectExternal listeners with the real
   sender id; web-page (matches) senders stay refused because a
   page-world sender carries no trusted cross-extension identity.
   Ports are long-lived named duplex channels with the same isolation. */

import type { ExtensionId, ExternallyConnectableSpec } from "./types";

export type MessageContext = "background" | "popup" | "options" | "content" | "extension-page";

export interface MessageSender {
  extensionId: ExtensionId;
  /* #560: Chrome parity. TM-class background dispatchers gate every
     action on sender.id === runtime.id and refuse a sender that
     carries neither an internal-scheme url nor the extension id. */
  id?: ExtensionId;
  context: MessageContext;
  url: string | null;
  /* #518: the origin of the sender page when the url is parseable
     (content-script and page senders); null for background worlds. */
  origin?: string | null;
}

/** The origin of a sender URL, or null when absent/unparseable. */
export function senderOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export type SendResponse = (response?: unknown) => void;
export type MessageListener = (msg: unknown, sender: MessageSender, sendResponse: SendResponse) => unknown;
export type ConnectListener = (port: ExtensionPort) => void;

export class ExtensionPort {
  private alive = true;
  private readonly onMsg: Set<(m: unknown) => void> = new Set();
  private readonly onDisc: Set<() => void> = new Set();

  constructor(
    readonly name: string,
    readonly sender: MessageSender,
    private readonly deliver: (m: unknown) => void,
    private readonly onOtherDisconnect: () => void
  ) {}

  postMessage(m: unknown): void {
    if (!this.alive) throw new Error("zeolite: attempted postMessage on disconnected port");
    this.deliver(m);
  }

  disconnect(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const l of this.onDisc) l();
    this.onOtherDisconnect();
  }

  /* Called by the far end of the pair. */
  receive(m: unknown): void {
    if (!this.alive) return;
    for (const l of this.onMsg) l(m);
  }

  notifyDisconnect(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const l of this.onDisc) l();
  }

  onMessage(l: (m: unknown) => void): void {
    this.onMsg.add(l);
  }

  onDisconnect(l: () => void): void {
    this.onDisc.add(l);
  }

  get isConnected(): boolean {
    return this.alive;
  }
}

interface PortPair {
  a: ExtensionPort;
  b: ExtensionPort;
}

export class ExtensionMessenger {
  private readonly listeners = new Map<ExtensionId, Set<MessageListener>>();
  private readonly connectListeners = new Map<ExtensionId, Set<ConnectListener>>();
  /* #518: external messaging. The externally_connectable gate is
     provided by the caller (the context wiring reads the live
     manager), keeping this module free of manager imports. */
  private externallyConnectableOf: ((id: ExtensionId) => { externallyConnectable: ExternallyConnectableSpec | null } | null) | null = null;
  private readonly externalListeners = new Map<ExtensionId, Set<MessageListener>>();
  private readonly externalConnectListeners = new Map<ExtensionId, Set<ConnectListener>>();

  setExternallyConnectableProvider(
    p: ((id: ExtensionId) => { externallyConnectable: ExternallyConnectableSpec | null } | null) | null,
  ): void {
    this.externallyConnectableOf = p;
  }

  /** The target's externally_connectable.ids gate: an exact id or a
     glob with `*` wildcards (Chrome-shaped, e.g. "*@vendor.example").
     matches governs web pages, which stay refused here (a page-world
     sender has no trusted cross-extension identity), so ids decide. */
  private externallyAllowed(targetId: ExtensionId, senderId: ExtensionId): boolean {
    const ec = this.externallyConnectableOf?.(targetId)?.externallyConnectable ?? null;
    if (!ec || ec.ids.length === 0) return false;
    for (const raw of ec.ids) {
      const pattern = typeof raw === "string" ? raw : "";
      if (!pattern) continue;
      if (pattern === "*") return true;
      const rx = new RegExp(
        "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
      );
      if (rx.test(senderId)) return true;
    }
    return false;
  }

  onMessage(id: ExtensionId, l: MessageListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  onConnect(id: ExtensionId, l: ConnectListener): () => void {
    let set = this.connectListeners.get(id);
    if (!set) {
      set = new Set();
      this.connectListeners.set(id, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** Drop every listener for one extension. Used by the background
      runtime when an idle-terminated MV3 service worker is torn down,
      so its next wake re-executes instead of silently answering with
      dead closures. */
  clear(id: ExtensionId): void {
    this.listeners.delete(id);
    this.connectListeners.delete(id);
    this.externalListeners.delete(id);
    this.externalConnectListeners.delete(id);
  }

  /* Fire-and-response messaging within one extension. Returns a
     promise with the responder's reply, or rejects when no listener
     answered. Response semantics follow the Gecko contract
     (runtime.onMessage): a listener may call sendResponse, OR return
     a plain value (sync response), OR return a Promise (async
     response, rejection fails the send). Returning true is the one
     Chrome-ism kept: it promises a later sendResponse. With multiple
     listeners the first response wins; a listener that neither
     responds nor keeps the channel open does not end the send. */
  async sendMessage(
    id: ExtensionId,
    from: MessageSender,
    msg: unknown
  ): Promise<unknown> {
    if (from.extensionId !== id) {
      throw new Error("zeolite: cross-extension messaging is not supported yet");
    }
    const set = this.listeners.get(id);
    if (!set || set.size === 0) {
      throw new Error("zeolite: could not establish connection. Receiving end does not exist");
    }
    return this.deliver(set, from, msg);
  }

  /* Long-lived duplex channel within one extension. Returns the
     caller's end; the receiving end is handed to onConnect listeners. */
  connect(id: ExtensionId, name: string, from: MessageSender): ExtensionPort {
    if (from.extensionId !== id) {
      throw new Error("zeolite: cross-extension port connection is not supported yet");
    }
    let caller: ExtensionPort | null = null;
    let receiver: ExtensionPort | null = null;
    caller = new ExtensionPort(
      name,
      from,
      (m) => receiver?.receive(m),
      () => receiver?.notifyDisconnect()
    );
    receiver = new ExtensionPort(
      name,
      { extensionId: id, id, context: "background", url: null },
      (m) => caller?.receive(m),
      () => caller?.notifyDisconnect()
    );
    const set = this.connectListeners.get(id);
    if (set) for (const l of set) l(receiver);
    return caller;
  }

  /* ---- #518: extension-to-extension external messaging ------------- */

  /** runtime.onMessageExternal listener registration. */
  onMessageExternal(id: ExtensionId, l: MessageListener): () => void {
    let set = this.externalListeners.get(id);
    if (!set) {
      set = new Set();
      this.externalListeners.set(id, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** runtime.onConnectExternal listener registration. */
  onConnectExternal(id: ExtensionId, l: ConnectListener): () => void {
    let set = this.externalConnectListeners.get(id);
    if (!set) {
      set = new Set();
      this.externalConnectListeners.set(id, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** Cross-extension sendMessage: Firefox delivers to the target's
      onMessageExternal listeners when the target's
      externally_connectable.ids admit the sender, and rejects with the
      receiving-end error otherwise (the disallowed case is not
      distinguishable from no listener, matching Gecko). */
  async sendMessageExternal(
    targetId: ExtensionId,
    from: MessageSender,
    msg: unknown
  ): Promise<unknown> {
    if (from.extensionId === targetId) {
      return this.sendMessage(targetId, from, msg);
    }
    if (!this.externallyAllowed(targetId, from.extensionId)) {
      throw new Error("zeolite: could not establish connection. Receiving end does not exist");
    }
    const set = this.externalListeners.get(targetId);
    if (!set || set.size === 0) {
      throw new Error("zeolite: could not establish connection. Receiving end does not exist");
    }
    const sender: MessageSender = {
      extensionId: from.extensionId,
      id: from.extensionId,
      context: from.context,
      url: from.url,
      origin: senderOrigin(from.url),
    };
    return this.deliver(set, sender, msg);
  }

  /** Cross-extension connect: same gate, receiver end handed to the
      target's onConnectExternal listeners. */
  connectExternal(targetId: ExtensionId, name: string, from: MessageSender): ExtensionPort {
    if (from.extensionId === targetId) {
      return this.connect(targetId, name, from);
    }
    if (!this.externallyAllowed(targetId, from.extensionId)) {
      throw new Error("zeolite: could not establish connection. Receiving end does not exist");
    }
    let caller: ExtensionPort | null = null;
    let receiver: ExtensionPort | null = null;
    caller = new ExtensionPort(
      name,
      { ...from, origin: senderOrigin(from.url) },
      (m) => receiver?.receive(m),
      () => receiver?.notifyDisconnect()
    );
    receiver = new ExtensionPort(
      name,
      /* The port the target sees carries the caller's identity, the
         same "sender is the other end" rule the internal connect
         follows. */
      { ...from, origin: senderOrigin(from.url) },
      (m) => caller?.receive(m),
      () => caller?.notifyDisconnect()
    );
    const set = this.externalConnectListeners.get(targetId);
    if (set) for (const l of set) l(receiver);
    return caller;
  }

  /** Shared Gecko response contract for one listener set (see
      sendMessage). Extracted so internal and external sends keep
      identical reply semantics. */
  private deliver(set: Set<MessageListener>, from: MessageSender, msg: unknown): Promise<unknown> {
    let settled = false;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("zeolite: message listener did not respond"));
        }
      }, 30000);
      const respond = (r?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      let keptOpen = false;
      let pending = 0;
      for (const l of set) {
        const sendResponse: SendResponse = respond;
        const ret = l(msg, from, sendResponse);
        if (ret !== null && ret !== undefined && typeof (ret as { then?: unknown }).then === "function") {
          /* Gecko async response: the returned promise IS the reply. */
          pending++;
          Promise.resolve(ret).then(respond, fail);
        } else if (ret !== undefined && ret !== null && ret !== true) {
          /* Gecko sync response: the returned value IS the reply. */
          respond(ret);
        } else if (ret === true) {
          keptOpen = true;
        }
      }
      /* Every listener stayed silent and none promised a reply: the
         honest result is a fulfilled-undefined send (pinned by
         messaging.test.ts). */
      if (!settled && pending === 0 && !keptOpen) respond(undefined);
    });
    return reply;
  }
}
