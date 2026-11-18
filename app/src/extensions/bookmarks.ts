/* Zeolite extension subsystem: browser.bookmarks (#520 slice).

   A real bookmark tree per extension, persisted to the subsystem's
   IndexedDB store (STORE_BOOKMARKS) so it survives worker restarts
   exactly like the alarm table (#594). Implements Firefox's full
   member surface: create/get/getChildren/getRecent/getTree/getSubTree/
   search/move/update/remove/removeTree with onCreated/onRemoved/
   onChanged/onMoved.

   Firefox semantics this honors (from the @types/firefox-webext-browser
   143.0.1 signatures and the MDN contract):
   - create() defaults to the Other Bookmarks folder ("unfiled_____")
     and to an empty title; a url makes a bookmark, no url a folder,
     and type "separator" creates a separator;
   - remove() refuses a folder that still has children (removeTree is
     the recursive form, and per Firefox's documented behavior a
     recursive removal fires a single onRemoved for the folder and
     none for its contents);
   - move() cannot place a node inside itself, and fires onMoved
     whenever the (parent, index) position changes;
   - update() changes title/url only, and a url only on bookmarks;
   - search() matches a word string against urls and titles, and the
     object form filters url/title verbatim (folders have no url);
   - get()/getChildren()/getRecent() return nodes without children;
     getTree()/getSubTree() return the deep hierarchy.

   Honest deviations, all documented in COMPAT under "bookmarks.*":
   the four roots are synthesized with empty titles (the engine has no
   localized bookmark UI), node ids are engine-generated opaque
   strings, and onChildrenReordered stays unmounted (Firefox marks it
   unsupported). Persistence is best-effort exactly like the alarms
   table: a store that cannot be opened or written degrades to the
   in-memory tree, never to a failed call. */

import type { ExtensionId } from "./types";
import { openDb, idbGet, idbGetAllKeys, idbDelete, idbPut, STORE_BOOKMARKS } from "./idb";

/* Firefox's fixed root ids (toolkit/components/places): the root node
   and its four permanent folders. */
export const BOOKMARKS_ROOT = "root________";
export const BOOKMARKS_MENU = "menu________";
export const BOOKMARKS_TOOLBAR = "toolbar_____";
export const BOOKMARKS_UNFILED = "unfiled_____";
export const BOOKMARKS_MOBILE = "mobile______";

export type BookmarkTreeNodeType = "bookmark" | "folder" | "separator";

export interface BookmarkTreeNode {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded?: number;
  dateGroupModified?: number;
  type?: BookmarkTreeNodeType;
  children?: BookmarkTreeNode[];
}

export interface BookmarkCreateDetails {
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
  type?: BookmarkTreeNodeType;
}

export interface BookmarkMoveDestination {
  parentId?: string;
  index?: number;
}

export interface BookmarkUpdateChanges {
  title?: string;
  url?: string;
}

export interface BookmarkRemoveInfo {
  parentId: string;
  index: number;
  node: BookmarkTreeNode;
}

export interface BookmarkChangeInfo {
  title: string;
  url?: string;
}

export interface BookmarkMoveInfo {
  parentId: string;
  index: number;
  oldParentId: string;
  oldIndex: number;
}

export type BookmarkSearchQuery =
  | string
  | { query?: string; url?: string; title?: string };

export type BookmarkCreatedListener = (id: string, bookmark: BookmarkTreeNode) => void;
export type BookmarkRemovedListener = (id: string, removeInfo: BookmarkRemoveInfo) => void;
export type BookmarkChangedListener = (id: string, changeInfo: BookmarkChangeInfo) => void;
export type BookmarkMovedListener = (id: string, moveInfo: BookmarkMoveInfo) => void;

/** The permanent folders every tree starts with, in Firefox's order. */
const ROOT_FOLDERS = [BOOKMARKS_MENU, BOOKMARKS_TOOLBAR, BOOKMARKS_UNFILED, BOOKMARKS_MOBILE];

const isRootId = (id: string): boolean => id === BOOKMARKS_ROOT || ROOT_FOLDERS.includes(id);

interface StoredNode {
  id: string;
  parentId: string;
  index: number;
  title: string;
  type: BookmarkTreeNodeType;
  url?: string;
  dateAdded: number;
  dateGroupModified?: number;
}

/** Hostile or corrupted store records are skipped on hydrate, never
    trusted (the alarms-table rule). */
function isStoredNode(v: unknown): v is StoredNode {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    n.id.length > 0 &&
    typeof n.parentId === "string" &&
    typeof n.index === "number" &&
    Number.isFinite(n.index) &&
    typeof n.title === "string" &&
    (n.type === "bookmark" || n.type === "folder" || n.type === "separator") &&
    (n.url === undefined || typeof n.url === "string") &&
    typeof n.dateAdded === "number" &&
    Number.isFinite(n.dateAdded) &&
    (n.dateGroupModified === undefined || (typeof n.dateGroupModified === "number" && Number.isFinite(n.dateGroupModified)))
  );
}

interface ExtBookmarks {
  nodes: Map<string, StoredNode>;
  created: Set<BookmarkCreatedListener>;
  removed: Set<BookmarkRemovedListener>;
  changed: Set<BookmarkChangedListener>;
  moved: Set<BookmarkMovedListener>;
}

export class BookmarkRegistry {
  private readonly exts = new Map<ExtensionId, ExtBookmarks>();
  private hydrated = false;
  private readonly inflight = new Set<Promise<void>>();

  private reg(id: ExtensionId): ExtBookmarks {
    let r = this.exts.get(id);
    if (!r) {
      r = { nodes: new Map(), created: new Set(), removed: new Set(), changed: new Set(), moved: new Set() };
      this.exts.set(id, r);
    }
    return r;
  }

  /* ---- tree materialization ---------------------------------------- */

  /** Direct children of a folder, ordered by index. */
  private childrenOf(r: ExtBookmarks, parentId: string): StoredNode[] {
    const out: StoredNode[] = [];
    for (const n of r.nodes.values()) if (n.parentId === parentId) out.push(n);
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  /** The public node shape for a stored record; deep also attaches
      children (folders get children: [] at minimum, as Firefox does). */
  private toNode(r: ExtBookmarks, stored: StoredNode, deep: boolean): BookmarkTreeNode {
    const node: BookmarkTreeNode = {
      id: stored.id,
      parentId: stored.parentId,
      index: stored.index,
      title: stored.title,
      dateAdded: stored.dateAdded,
      type: stored.type,
      ...(stored.url !== undefined ? { url: stored.url } : {}),
      ...(stored.dateGroupModified !== undefined ? { dateGroupModified: stored.dateGroupModified } : {}),
    };
    if (deep && stored.type === "folder") {
      node.children = this.childrenOf(r, stored.id).map((c) => this.toNode(r, c, true));
    }
    return node;
  }

  private rootNode(r: ExtBookmarks, deep: boolean): BookmarkTreeNode {
    return {
      id: BOOKMARKS_ROOT,
      title: "",
      type: "folder",
      ...(deep
        ? {
            children: ROOT_FOLDERS.map((fid) => ({
              id: fid,
              parentId: BOOKMARKS_ROOT,
              index: ROOT_FOLDERS.indexOf(fid),
              title: "",
              type: "folder" as const,
              dateAdded: 0,
              children: this.childrenOf(r, fid).map((c) => this.toNode(r, c, true)),
            })),
          }
        : {}),
    };
  }

  private materialize(r: ExtBookmarks, id: string, deep: boolean): BookmarkTreeNode | undefined {
    if (id === BOOKMARKS_ROOT) return this.rootNode(r, deep);
    const stored = r.nodes.get(id);
    if (stored) return this.toNode(r, stored, deep);
    if (isRootId(id)) {
      return {
        id,
        parentId: BOOKMARKS_ROOT,
        index: ROOT_FOLDERS.indexOf(id),
        title: "",
        type: "folder",
        ...(deep ? { children: this.childrenOf(r, id).map((c) => this.toNode(r, c, true)) } : {}),
      };
    }
    return undefined;
  }

  /* ---- API methods -------------------------------------------------- */

  /** Firefox: no parentId means the Other Bookmarks folder; no title
      means ""; a url makes a bookmark, no url a folder; separators
      carry neither. index clamps into the destination folder. */
  create(id: ExtensionId, details: BookmarkCreateDetails = {}): Promise<BookmarkTreeNode> {
    const r = this.reg(id);
    if (details.parentId === BOOKMARKS_ROOT) {
      return Promise.reject(new Error("zeolite: bookmarks.create: cannot create under the root"));
    }
    const parentId = details.parentId ?? BOOKMARKS_UNFILED;
    const parent = isRootId(parentId) ? null : r.nodes.get(parentId);
    if (!(isRootId(parentId) || parent?.type === "folder")) {
      return Promise.reject(new Error("zeolite: bookmarks.create: parentId does not name a folder: " + parentId));
    }
    const type: BookmarkTreeNodeType =
      details.type ?? (details.url !== undefined ? "bookmark" : "folder");
    if (type === "bookmark" && details.url === undefined) {
      return Promise.reject(new Error("zeolite: bookmarks.create: a bookmark needs a url"));
    }
    if (type === "folder" && details.url !== undefined) {
      return Promise.reject(new Error("zeolite: bookmarks.create: a folder cannot carry a url"));
    }
    if (type === "separator" && details.url !== undefined) {
      return Promise.reject(new Error("zeolite: bookmarks.create: a separator cannot carry a url"));
    }
    if (details.url !== undefined) {
      let ok = false;
      try {
        ok = new URL(details.url).href.length > 0;
      } catch {
        ok = false;
      }
      if (!ok) return Promise.reject(new Error("zeolite: bookmarks.create: invalid url: " + details.url));
    }
    const siblings = this.childrenOf(r, parentId);
    const index = Math.max(0, Math.min(details.index ?? siblings.length, siblings.length));
    let nodeId = "";
    do {
      nodeId = "bm" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    } while (r.nodes.has(nodeId));
    const now = Date.now();
    const stored: StoredNode = {
      id: nodeId,
      parentId,
      index,
      title: type === "separator" ? "" : (details.title ?? ""),
      type,
      ...(details.url !== undefined ? { url: details.url } : {}),
      dateAdded: now,
      ...(type === "folder" ? { dateGroupModified: now } : {}),
    };
    /* Insert at the clamped position and re-index the right-hand
       siblings so indexes stay contiguous. */
    for (const s of siblings) if (s.index >= index) s.index += 1;
    r.nodes.set(nodeId, stored);
    if (type === "folder") {
      const p = isRootId(parentId) ? null : r.nodes.get(parentId);
      if (p) p.dateGroupModified = now;
    }
    this.persistExt(id);
    const node = this.toNode(r, stored, true);
    for (const l of [...r.created]) {
      try {
        l(nodeId, node);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return Promise.resolve(node);
  }

  /** Firefox: every requested id must resolve, or the call rejects. */
  get(id: ExtensionId, idOrIdList: string | string[]): Promise<BookmarkTreeNode[]> {
    const r = this.reg(id);
    const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
    const out: BookmarkTreeNode[] = [];
    for (const one of ids) {
      const node = this.materialize(r, one, false);
      if (!node) return Promise.reject(new Error("zeolite: bookmarks.get: no bookmark found for id: " + one));
      out.push(node);
    }
    return Promise.resolve(out);
  }

  getChildren(id: ExtensionId, folderId: string): Promise<BookmarkTreeNode[]> {
    const r = this.reg(id);
    if (!this.materialize(r, folderId, false)) {
      return Promise.reject(new Error("zeolite: bookmarks.getChildren: no bookmark found for id: " + folderId));
    }
    return Promise.resolve(this.childrenOf(r, folderId).map((c) => this.toNode(r, c, false)));
  }

  /** The most recently added nodes, newest first. */
  getRecent(id: ExtensionId, numberOfItems: number): Promise<BookmarkTreeNode[]> {
    const r = this.reg(id);
    const all = [...r.nodes.values()].sort((a, b) => b.dateAdded - a.dateAdded);
    return Promise.resolve(all.slice(0, Math.max(0, numberOfItems)).map((n) => this.toNode(r, n, false)));
  }

  getTree(id: ExtensionId): Promise<BookmarkTreeNode[]> {
    return Promise.resolve([this.rootNode(this.reg(id), true)]);
  }

  getSubTree(id: ExtensionId, subtreeId: string): Promise<BookmarkTreeNode[]> {
    const r = this.reg(id);
    const node = this.materialize(r, subtreeId, true);
    if (!node) return Promise.reject(new Error("zeolite: bookmarks.getSubTree: no bookmark found for id: " + subtreeId));
    return Promise.resolve([node]);
  }

  /** Words AND-match against url+title case-insensitively; the object
      form filters url/title verbatim (folders have no url). Roots are
      never returned. */
  search(id: ExtensionId, query: BookmarkSearchQuery): Promise<BookmarkTreeNode[]> {
    const r = this.reg(id);
    const filters: { words: string[]; url?: string; title?: string }[] = [];
    const addObject = (o: { query?: string; url?: string; title?: string }): void => {
      filters.push({
        words: typeof o.query === "string" ? o.query.split(/\s+/).filter((w) => w.length > 0) : [],
        ...(o.url !== undefined ? { url: o.url } : {}),
        ...(o.title !== undefined ? { title: o.title } : {}),
      });
    };
    if (typeof query === "string") addObject({ query });
    else addObject(query);
    const out: BookmarkTreeNode[] = [];
    for (const n of r.nodes.values()) {
      const node = this.toNode(r, n, false);
      const hay = (n.url ?? "").toLowerCase() + "\n" + n.title.toLowerCase();
      const matched = filters.every((f) => {
        if (f.url !== undefined && n.url !== f.url) return false;
        if (f.title !== undefined && n.title !== f.title) return false;
        for (const w of f.words) if (!hay.includes(w.toLowerCase())) return false;
        return true;
      });
      if (matched) out.push(node);
    }
    return Promise.resolve(out);
  }

  /** Firefox: a node cannot be moved into itself; onMoved fires
      whenever the (parent, index) position changes, including a
      reorder inside the same folder. */
  move(id: ExtensionId, nodeId: string, destination: BookmarkMoveDestination): Promise<BookmarkTreeNode> {
    const r = this.reg(id);
    const node = r.nodes.get(nodeId);
    if (!node) return Promise.reject(new Error("zeolite: bookmarks.move: no bookmark found for id: " + nodeId));
    const newParentId = destination.parentId ?? node.parentId;
    if (newParentId === BOOKMARKS_ROOT) {
      return Promise.reject(new Error("zeolite: bookmarks.move: cannot move a node into the root"));
    }
    const newParent = isRootId(newParentId) ? null : r.nodes.get(newParentId);
    if (!(isRootId(newParentId) || newParent?.type === "folder")) {
      return Promise.reject(new Error("zeolite: bookmarks.move: destination does not name a folder: " + newParentId));
    }
    /* Cycle guard: walking up from the destination must never reach
       the moved node (stored nodes only; the permanent folders cannot
       be descendants of anything). */
    let walk: string | undefined = newParentId;
    while (walk !== undefined && !isRootId(walk)) {
      if (walk === nodeId) {
        return Promise.reject(new Error("zeolite: bookmarks.move: cannot move a bookmark inside itself"));
      }
      walk = r.nodes.get(walk)?.parentId;
    }
    const oldParentId = node.parentId;
    const oldIndex = node.index;
    if (oldParentId !== newParentId) {
      /* Re-index the old folder, then the new one. The destination's
         children are read BEFORE the node re-parents, so the moved
         node itself is never in the set being shifted. */
      const olds = this.childrenOf(r, oldParentId);
      for (const s of olds) if (s.index > oldIndex) s.index -= 1;
      const targets = this.childrenOf(r, newParentId);
      node.parentId = newParentId;
      node.index = Math.max(0, Math.min(destination.index ?? targets.length, targets.length));
      for (const s of targets) if (s.index >= node.index) s.index += 1;
    } else if (destination.index !== undefined && destination.index !== oldIndex) {
      const siblings = this.childrenOf(r, newParentId).filter((s) => s.id !== nodeId);
      const target = Math.max(0, Math.min(destination.index, siblings.length));
      let seen = 0;
      for (const s of siblings) {
        s.index = seen < target ? seen : seen + 1;
        seen++;
      }
      node.index = target;
    } else {
      return Promise.resolve(this.toNode(r, node, false));
    }
    this.persistExt(id);
    const moveInfo: BookmarkMoveInfo = { parentId: newParentId, index: node.index, oldParentId, oldIndex };
    for (const l of [...r.moved]) {
      try {
        l(nodeId, moveInfo);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return Promise.resolve(this.toNode(r, node, false));
  }

  /** Firefox: title and url only; a url only on bookmarks. */
  update(id: ExtensionId, nodeId: string, changes: BookmarkUpdateChanges): Promise<BookmarkTreeNode> {
    const r = this.reg(id);
    const node = r.nodes.get(nodeId);
    if (!node) return Promise.reject(new Error("zeolite: bookmarks.update: no bookmark found for id: " + nodeId));
    if (changes.url !== undefined) {
      if (node.type !== "bookmark") {
        return Promise.reject(new Error("zeolite: bookmarks.update: only bookmarks carry a url"));
      }
      let ok = false;
      try {
        ok = new URL(changes.url).href.length > 0;
      } catch {
        ok = false;
      }
      if (!ok) return Promise.reject(new Error("zeolite: bookmarks.update: invalid url: " + changes.url));
      node.url = changes.url;
    }
    if (changes.title !== undefined) node.title = changes.title;
    this.persistExt(id);
    const changeInfo: BookmarkChangeInfo = { title: node.title, ...(node.url !== undefined ? { url: node.url } : {}) };
    for (const l of [...r.changed]) {
      try {
        l(nodeId, changeInfo);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return Promise.resolve(this.toNode(r, node, false));
  }

  /** Firefox: refuses a folder that still has children; removeTree is
      the recursive form. */
  remove(id: ExtensionId, nodeId: string): Promise<void> {
    const r = this.reg(id);
    const node = r.nodes.get(nodeId);
    if (!node) return Promise.reject(new Error("zeolite: bookmarks.remove: no bookmark found for id: " + nodeId));
    if (node.type === "folder" && this.childrenOf(r, nodeId).length > 0) {
      return Promise.reject(new Error("zeolite: bookmarks.remove: cannot remove a folder that is not empty"));
    }
    const removeInfo: BookmarkRemoveInfo = {
      parentId: node.parentId,
      index: node.index,
      node: this.toNode(r, node, false),
    };
    const olds = this.childrenOf(r, node.parentId);
    for (const s of olds) if (s.index > node.index) s.index -= 1;
    r.nodes.delete(nodeId);
    this.persistExt(id);
    for (const l of [...r.removed]) {
      try {
        l(nodeId, removeInfo);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return Promise.resolve();
  }

  /** Recursive removal: a single onRemoved for the subtree root,
      exactly as Firefox documents. */
  removeTree(id: ExtensionId, nodeId: string): Promise<void> {
    const r = this.reg(id);
    const node = r.nodes.get(nodeId);
    if (!node) return Promise.reject(new Error("zeolite: bookmarks.removeTree: no bookmark found for id: " + nodeId));
    const snapshot = this.toNode(r, node, true);
    const doomed: string[] = [nodeId];
    for (let i = 0; i < doomed.length; i++) {
      for (const n of this.childrenOf(r, doomed[i])) doomed.push(n.id);
    }
    const removeInfo: BookmarkRemoveInfo = { parentId: node.parentId, index: node.index, node: snapshot };
    const olds = this.childrenOf(r, node.parentId);
    for (const s of olds) if (s.index > node.index) s.index -= 1;
    for (const d of doomed) r.nodes.delete(d);
    this.persistExt(id);
    for (const l of [...r.removed]) {
      try {
        l(nodeId, removeInfo);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return Promise.resolve();
  }

  /* ---- events -------------------------------------------------------- */

  onCreated(id: ExtensionId, l: BookmarkCreatedListener): () => void {
    const r = this.reg(id);
    r.created.add(l);
    return () => {
      r.created.delete(l);
    };
  }

  onRemoved(id: ExtensionId, l: BookmarkRemovedListener): () => void {
    const r = this.reg(id);
    r.removed.add(l);
    return () => {
      r.removed.delete(l);
    };
  }

  onChanged(id: ExtensionId, l: BookmarkChangedListener): () => void {
    const r = this.reg(id);
    r.changed.add(l);
    return () => {
      r.changed.delete(l);
    };
  }

  onMoved(id: ExtensionId, l: BookmarkMovedListener): () => void {
    const r = this.reg(id);
    r.moved.add(l);
    return () => {
      r.moved.delete(l);
    };
  }

  /* ---- lifecycle / persistence --------------------------------------- */

  /** Engine hook: drop everything an extension owned (uninstall). */
  drop(id: ExtensionId): void {
    if (!this.exts.has(id)) return;
    this.exts.delete(id);
    this.persistExt(id);
  }

  /** Load every persisted tree. Merge-guarded like the alarm table:
      state already live in memory wins, corrupted records are skipped,
      and a broken store leaves honest in-memory trees. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const db = await openDb();
      const extIds = await idbGetAllKeys(db, STORE_BOOKMARKS);
      for (const extId of extIds) {
        const recs = await idbGet(db, STORE_BOOKMARKS, extId);
        if (!Array.isArray(recs)) continue;
        const r = this.reg(extId);
        for (const v of recs) {
          if (!isStoredNode(v)) continue;
          if (r.nodes.has(v.id)) continue; /* merge guard */
          r.nodes.set(v.id, v);
        }
        this.persistExt(extId);
      }
    } catch {
      /* no IndexedDB (or a broken store): in-memory trees only */
    }
  }

  /** Write one extension's tree. Best-effort by design: a rejected
      write is dropped and never propagates into call semantics. */
  private persistExt(id: ExtensionId): void {
    if (!this.hydrated) return;
    const r = this.exts.get(id);
    const p = openDb()
      .then((db) =>
        r === undefined ? idbDelete(db, STORE_BOOKMARKS, id) : idbPut(db, STORE_BOOKMARKS, id, [...r.nodes.values()]),
      )
      .catch(() => undefined);
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
    });
  }

  /** Tests: await every in-flight persistence write. */
  async flushForTests(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  resetForTests(): void {
    this.exts.clear();
    this.hydrated = false;
  }
}

export const BOOKMARKS = new BookmarkRegistry();
