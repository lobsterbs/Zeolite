/* Zeolite extension subsystem: message passing.

   Channels are strictly per-extension. Every message names its target
   extension id and the router refuses delivery to any other extension;
   cross-extension messaging is recorded through
   externally_connectable but external delivery is reported as
   unsupported rather than silently dropped. Ports are long-lived
   named duplex channels with the same isolation. */

import type { ExtensionId } from "./types";

export type MessageContext = "background" | "popup" | "options" | "content" | "extension-page";

export interface MessageSender {
  extensionId: ExtensionId;
  context: MessageContext;
  url: string | null;
}

export type SendResponse = (response?: unknown) => void;
export type MessageListener = (msg: unknown, sender: MessageSender, sendResponse: SendResponse) => boolean | void;
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
  }

  /* Fire-and-response messaging within one extension. Returns a
     promise with the responder's reply, or rejects when no listener
     answered. */
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
    let settled = false;
    const responders: SendResponse[] = [];
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("zeolite: message listener did not respond"));
        }
      }, 30000);
      for (const l of set) {
        const sendResponse: SendResponse = (r?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        responders.push(sendResponse);
        const keepOpen = l(msg, from, sendResponse);
        if (keepOpen !== true) sendResponse(undefined);
      }
    });
    return reply;
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
      { extensionId: id, context: "background", url: null },
      (m) => caller?.receive(m),
      () => caller?.notifyDisconnect()
    );
    const set = this.connectListeners.get(id);
    if (set) for (const l of set) l(receiver);
    return caller;
  }
}

