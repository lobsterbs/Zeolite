/* Zeolite extension subsystem: tabs bridge.

   The UI (LobsterBrowse) owns the real tab model. The engine's service
   worker learns about tabs through a UI -> SW sync channel (the
   zl:tabs control message) and extensions observe and request changes
   through the same channel in the opposite direction: create/update/
   remove are dispatched to the engine UI clients as zl:tabsOp
   postMessages, and their promises resolve when the requested change
   shows up in a later sync Ã¢ÂÂ the UI never needs a direct reply.

   Permission semantics follow Firefox: url/title visibility in Tab
   objects and changeInfo requires the "tabs" permission or a matching
   host permission, enforced in tabView/changeView at the API layer. */

import type { ExtensionRecord } from "./types";
import { hostPatternsMatch } from "./permissions";

export interface UiTab {
  id: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  incognito?: boolean;
  pinned?: boolean;
  windowId?: number;
  /** UI-set marker used to resolve a pending tabs.create(). */
  nonce?: string;
}

export interface TabChangeInfo {
  url?: string;
  title?: string;
  pinned?: boolean;
  active?: boolean;
}

export type TabsEvent =
  | { type: "created"; tab: UiTab }
  | { type: "updated"; tabId: number; change: TabChangeInfo; tab: UiTab }
  | { type: "activated"; tabId: number; windowId: number }
  | { type: "removed"; tabId: number; windowId: number };

export type TabsListener = (ev: TabsEvent) => void;

export interface TabsOp {
  op: "create" | "update" | "remove";
  nonce?: string;
  tabId?: number;
  props?: Record<string, unknown>;
}

/** One background -> content-script message envelope
    (tabs.sendMessage). */
export interface TabMessage {
  nonce: string;
  msg: unknown;
}

type CreateProps = { url?: string; active?: boolean; index?: number };
type UpdateProps = { active?: boolean; url?: string };

function cloneTab(t: UiTab): UiTab {
  return { ...t };
}

function validUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ftp:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

type PendingUpdate = { want: UpdateProps; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/* #283: UI tab-op acknowledgement deadline; a host that never
   syncs settles the promise instead of leaving it pending forever. */
const OP_DEADLINE_MS = 30000;

export class TabRegistry {
  private readonly tabs = new Map<number, UiTab>();
  private readonly listeners = new Set<TabsListener>();
  private readonly pendingCreate = new Map<string, (t: UiTab) => void>();
  private readonly pendingRemove = new Map<
    number,
    Array<{ timer: ReturnType<typeof setTimeout>; done: () => void }>
  >();
  private readonly pendingUpdate = new Map<number, PendingUpdate[]>();
  private dispatch: ((op: TabsOp) => void) | null = null;
  private messageDispatch:
    | ((tabId: number, tabUrl: string, extId: string, payload: TabMessage) => void)
    | null = null;
  private readonly pendingMessages = new Map<
    string,
    { tabId: number; extId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nonceSeq = 0;

  setDispatch(fn: ((op: TabsOp) => void) | null): void {
    this.dispatch = fn;
  }

  /** Engine hook: where background -> content-script messages go. The
      host (SW) addresses pages by destination, so the target tab's
      url travels with every delivery. */
  setMessageDispatch(
    fn: ((tabId: number, tabUrl: string, extId: string, payload: TabMessage) => void) | null,
  ): void {
    this.messageDispatch = fn;
  }

  /** tabs.sendMessage: deliver to a tab's content scripts and resolve
      with the first listener reply. Firefox semantics: a matching
      host permission is required; a missing tab or a missing dispatch
      host rejects honestly. Frame targeting is not supported (see
      ./compat), and a caller that asks for one is rejected instead of
      having the option silently ignored. A tab whose page never
      answers rejects on the 30s timeout â or immediately when the tab
      is removed, whichever comes first. */
  sendMessage(
    ext: ExtensionRecord,
    tabId: number,
    msg: unknown,
    options?: { frameId?: number },
  ): Promise<unknown> {
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.reject(new Error("Invalid tab ID: " + tabId));
    if (options && options.frameId !== undefined) {
      return Promise.reject(
        new Error("zeolite: frame targeting is not supported; content scripts run in the page world"),
      );
    }
    if (!hostPatternsMatch(ext.hostPermissions, tab.url)) {
      return Promise.reject(
        new Error("zeolite: tabs.sendMessage requires a host permission for " + tab.url),
      );
    }
    if (!this.messageDispatch) {
      return Promise.reject(new Error("zeolite: no tab host attached to this engine"));
    }
    const dispatch = this.messageDispatch;
    /* #185: a predictable "zl-m<n>" nonce let any content script
       guess or brute-force another extension's reply nonces; a
       per-send random nonce makes them unguessable. */
    const nonce =
      "zl-m-" +
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : ++this.nonceSeq + "-" + Math.random().toString(36).slice(2));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingMessages.delete(nonce)) {
          reject(new Error("zeolite: tabs.sendMessage timed out; no content-script listener replied"));
        }
      }, 30000);
      this.pendingMessages.set(nonce, {
        tabId,
        extId: ext.id,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      dispatch(tabId, tab.url, ext.id, { nonce, msg });
    });
  }

  /** Tab removed: every still-pending sendMessage to it fails now,
      not on the 30s timeout â the page that would answer is gone. */
  private rejectPendingForTab(tabId: number): void {
    for (const [nonce, p] of this.pendingMessages) {
      if (p.tabId !== tabId) continue;
      this.pendingMessages.delete(nonce);
      p.reject(new Error("zeolite: tab closed before a content script replied"));
    }
  }

  /** Content-script reply routed back through the SW (zl:ext
      __zlTabReply). Only the first reply to a nonce resolves. */
  resolveTabMessage(nonce: string, extId: string, response: unknown): void {
    const p = this.pendingMessages.get(nonce);
    /* #185: the reply binds to the extension that sent the message;
       another extension answering with the same nonce is a no-op. */
    if (!p || p.extId !== extId) return;
    this.pendingMessages.delete(nonce);
    p.resolve(response);
  }

  /** Content-script error report (zl:ext __zlTabError): the bridge
      answers honestly when no listener is registered. */
  rejectTabMessage(nonce: string, extId: string, error: string): void {
    const p = this.pendingMessages.get(nonce);
    /* #185: same binding as resolveTabMessage. */
    if (!p || p.extId !== extId) return;
    this.pendingMessages.delete(nonce);
    p.reject(new Error(error));
  }

  subscribe(l: TabsListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  list(): UiTab[] {
    const out: UiTab[] = [];
    for (const t of this.tabs.values()) out.push(cloneTab(t));
    return out.sort((a, b) => a.index - b.index);
  }

  get(id: number): UiTab | null {
    const t = this.tabs.get(id);
    return t ? cloneTab(t) : null;
  }

  activeTab(): UiTab | null {
    for (const t of this.tabs.values()) if (t.active) return cloneTab(t);
    return null;
  }

  /* #286: WebExtension title patterns are glob-style (a "*" matches any
     run of characters); a pattern without "*" is an exact match. */
  private titleMatch(pat: string, title: string): boolean {
    if (!pat.includes("*")) return pat === title;
    const re = new RegExp(
      "^" + pat.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    );
    return re.test(title);
  }

  query(q: Record<string, unknown>): UiTab[] {
    /* #286: title filtering (string or array of patterns). */
    const titlePats =
      q.title === undefined
        ? null
        : (Array.isArray(q.title) ? q.title : [q.title]).map(String);
    const out: UiTab[] = [];
    for (const t of this.tabs.values()) {
      if (q.active !== undefined && t.active !== !!q.active) continue;
      if (q.pinned !== undefined && !!(t.pinned ?? false) !== !!q.pinned) continue;
      if (q.windowId !== undefined && (t.windowId ?? 1) !== q.windowId) continue;
      if (q.index !== undefined && t.index !== q.index) continue;
      if (q.url !== undefined) {
        const pats = (Array.isArray(q.url) ? q.url : [q.url]).map(String);
        if (!hostPatternsMatch(pats, t.url)) continue;
      }
      if (titlePats && !titlePats.some((p) => this.titleMatch(p, t.title ?? ""))) continue;
      out.push(cloneTab(t));
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** UI -> SW authoritative sync. Diffs against the previous state,
      fires tab events, and resolves pending extension ops. */
  syncFromUi(incoming: UiTab[]): void {
    const next = new Map<number, UiTab>();
    for (const raw of incoming) {
      if (typeof raw.id !== "number" || typeof raw.url !== "string") continue;
      next.set(raw.id, cloneTab(raw));
    }
    for (const [id, prev] of this.tabs) {
      if (next.has(id)) continue;
      this.fire({ type: "removed", tabId: id, windowId: prev.windowId ?? 1 });
      this.rejectPendingForTab(id);
      const waits = this.pendingRemove.get(id);
      if (waits) {
        this.pendingRemove.delete(id);
        for (const w of waits) {
          clearTimeout(w.timer);
          w.done();
        }
      }
      /* #283: a closed tab settles its still-pending updates too. */
      const ups = this.pendingUpdate.get(id);
      if (ups) {
        this.pendingUpdate.delete(id);
        for (const w of ups) {
          clearTimeout(w.timer);
          w.reject(new Error("zeolite: tab closed before the update was observed"));
        }
      }
    }
    for (const [id, t] of next) {
      const prev = this.tabs.get(id);
      if (!prev) {
        this.fire({ type: "created", tab: cloneTab(t) });
        continue;
      }
      const change: TabChangeInfo = {};
      if (t.url !== prev.url) change.url = t.url;
      if (t.title !== prev.title) change.title = t.title;
      if (!!(t.pinned ?? false) !== !!(prev.pinned ?? false)) change.pinned = !!(t.pinned ?? false);
      if (t.active && !prev.active) change.active = true;
      if (Object.keys(change).length > 0) {
        this.fire({ type: "updated", tabId: id, change, tab: cloneTab(t) });
      }
      if (t.active && !prev.active) {
        this.fire({ type: "activated", tabId: id, windowId: t.windowId ?? 1 });
      }
    }
    this.tabs.clear();
    for (const [id, t] of next) this.tabs.set(id, t);
    /* Pending creates resolve when the new tab arrives carrying the
       op nonce; the marker never stays in registry state. */
    for (const t of this.tabs.values()) {
      if (typeof t.nonce !== "string") continue;
      const resolve = this.pendingCreate.get(t.nonce);
      this.pendingCreate.delete(t.nonce);
      const done = cloneTab(t);
      delete t.nonce;
      if (resolve) resolve(done);
    }
    /* Pending updates resolve when the change is observed. */
    for (const [id, waits] of [...this.pendingUpdate.entries()]) {
      const t = this.tabs.get(id);
      const still: PendingUpdate[] = [];
      for (const w of waits) {
        if (t && this.satisfied(t, w.want)) {
          clearTimeout(w.timer);
          w.resolve();
        } else still.push(w);
      }
      if (still.length === 0) this.pendingUpdate.delete(id);
      else this.pendingUpdate.set(id, still);
    }
  }

  private satisfied(t: UiTab, want: UpdateProps): boolean {
    if (want.active !== undefined && t.active !== !!want.active) return false;
    if (want.url !== undefined && t.url !== want.url) return false;
    return true;
  }

  create(props: CreateProps): Promise<UiTab> {
    if (!this.dispatch) return Promise.reject(new Error("zeolite: no tab host attached to this engine"));
    if (props.url !== undefined && !validUrl(props.url)) {
      return Promise.reject(new Error("zeolite: tabs.create: unsupported URL: " + String(props.url)));
    }
    const nonce = "zl-c" + ++this.nonceSeq;
    /* #283: the op settles even when no UI sync ever acknowledges it. */
    const p = new Promise<UiTab>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCreate.delete(nonce)) {
          reject(new Error("zeolite: tabs.create timed out; no tab host acknowledgement"));
        }
      }, OP_DEADLINE_MS);
      this.pendingCreate.set(nonce, (t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
    this.dispatch({ op: "create", nonce, props: { ...props } });
    return p;
  }

  update(tabId: number | null, props: UpdateProps): Promise<void> {
    if (!this.dispatch) return Promise.reject(new Error("zeolite: no tab host attached to this engine"));
    const id = tabId ?? this.activeTab()?.id ?? null;
    if (id === null || !this.tabs.has(id)) {
      return Promise.reject(new Error("Invalid tab ID: " + String(id)));
    }
    const want: UpdateProps = {};
    if (props.active !== undefined) want.active = !!props.active;
    if (props.url !== undefined) want.url = props.url;
    return new Promise<void>((resolve, reject) => {
      let waits = this.pendingUpdate.get(id);
      if (!waits) {
        waits = [];
        this.pendingUpdate.set(id, waits);
      }
      /* #283: a pending update that never becomes true rejects on the
         deadline instead of living in the map forever. */
      const timer = setTimeout(() => {
        const list = this.pendingUpdate.get(id);
        if (!list) return;
        const rest = list.filter((w) => w.timer !== timer);
        if (rest.length === 0) this.pendingUpdate.delete(id);
        else this.pendingUpdate.set(id, rest);
        reject(new Error("zeolite: tabs.update timed out; the change was never observed"));
      }, OP_DEADLINE_MS);
      waits.push({ want, resolve, reject, timer });
      this.dispatch?.({ op: "update", tabId: id, props: { ...want } });
    });
  }

  remove(ids: number[]): Promise<void> {
    if (!this.dispatch) return Promise.reject(new Error("zeolite: no tab host attached to this engine"));
    for (const id of ids) {
      if (!this.tabs.has(id)) return Promise.reject(new Error("Invalid tab ID: " + id));
    }
    const uniq = [...new Set(ids)];
    return new Promise<void>((resolve, reject) => {
      let left = uniq.length;
      let failed = false;
      for (const id of uniq) {
        let waits = this.pendingRemove.get(id);
        if (!waits) {
          waits = [];
          this.pendingRemove.set(id, waits);
        }
        /* #283: per-tab removal deadline keeps the map bounded when a
           tab host never acknowledges the op. */
        const timer = setTimeout(() => {
          const list = this.pendingRemove.get(id);
          if (!list) return;
          const rest = list.filter((w) => w.timer !== timer);
          if (rest.length === 0) this.pendingRemove.delete(id);
          else this.pendingRemove.set(id, rest);
          if (!failed) {
            failed = true;
            reject(new Error("zeolite: tabs.remove timed out; the tab was never observed gone"));
          }
        }, OP_DEADLINE_MS);
        waits.push({
          timer,
          done: () => {
            clearTimeout(timer);
            if (--left === 0) resolve();
          },
        });
        this.dispatch?.({ op: "remove", tabId: id });
      }
    });
  }

  private fire(ev: TabsEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const TABS = new TabRegistry();

function canSeeUrl(ext: ExtensionRecord, url: string): boolean {
  return ext.permissions.includes("tabs") || hostPatternsMatch(ext.hostPermissions, url);
}

/** The Tab object one extension is allowed to see (Firefox permission
    semantics: url/title only with the tabs or a matching host
    permission). */
export function tabView(ext: ExtensionRecord, tab: UiTab): Record<string, unknown> {
  const allowed = canSeeUrl(ext, tab.url);
  return {
    id: tab.id,
    index: tab.index,
    windowId: tab.windowId ?? 1,
    active: tab.active,
    pinned: !!(tab.pinned ?? false),
    incognito: !!(tab.incognito ?? false),
    ...(allowed ? { url: tab.url, title: tab.title } : {}),
  };
}

/** changeInfo view (#271): url/title visibility is gated against the
    tab's CURRENT url, not only change.url - a title-only change on a
    page the extension cannot see must not leak the new title. */
export function changeView(
  ext: ExtensionRecord,
  change: TabChangeInfo,
  tabUrl?: string,
): Record<string, unknown> {
  const allowed = canSeeUrl(ext, change.url ?? tabUrl ?? "");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change)) {
    if ((k === "url" || k === "title") && !allowed) continue;
    out[k] = v;
  }
  return out;
}


