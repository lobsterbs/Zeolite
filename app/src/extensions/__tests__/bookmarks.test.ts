/* #520 slice: browser.bookmarks over the persisted per-extension tree.
   Firefox semantics from the @types/firefox-webext-browser 143.0.1
   signatures: create defaults (Other Bookmarks folder, empty title,
   url => bookmark / no url => folder / separator), leaf-only remove,
   single-notification removeTree, cycle-safe move with onMoved for
   reorders, title/url-only update (url on bookmarks only), word-based
   search with verbatim url/title object filters, and the four
   permanent roots. Persistence follows the #594 alarms pattern. */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOKMARKS,
  BOOKMARKS_MENU,
  BOOKMARKS_ROOT,
  BOOKMARKS_TOOLBAR,
  BOOKMARKS_UNFILED,
  type BookmarkRemoveInfo,
} from "../bookmarks";

const EXT = "bmtest@example";
const EXT2 = "other@example";

describe("bookmarks registry (#520)", () => {
  beforeEach(() => {
    /* hydrate stays off for the mutation tests: pre-hydration writes
       are by design no-ops, so every test starts from an empty tree.
       The persistence test hydrates explicitly, like the alarms
       suite does. */
    BOOKMARKS.resetForTests();
  });

  afterEach(async () => {
    await BOOKMARKS.flushForTests();
    BOOKMARKS.resetForTests();
  });

  /* ---- default tree ------------------------------------------------ */

  it("starts every extension with the four permanent roots under root", async () => {
    const tree = await BOOKMARKS.getTree(EXT);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.id).toBe(BOOKMARKS_ROOT);
    expect(root.type).toBe("folder");
    expect(root.children!.map((c) => c.id)).toEqual([BOOKMARKS_MENU, BOOKMARKS_TOOLBAR, BOOKMARKS_UNFILED, "mobile______"]);
    for (const folder of root.children!) {
      expect(folder.parentId).toBe(BOOKMARKS_ROOT);
      expect(folder.type).toBe("folder");
      expect(folder.children).toEqual([]);
    }
  });

  it("does not share trees between extensions", async () => {
    await BOOKMARKS.create(EXT, { title: "a", url: "https://a.example/" });
    const other = await BOOKMARKS.getTree(EXT2);
    expect(other[0].children!.find((c) => c.id === BOOKMARKS_UNFILED)!.children).toEqual([]);
  });

  /* ---- create ------------------------------------------------------- */

  it("create defaults to Other Bookmarks with an empty title and bookmark type", async () => {
    const node = await BOOKMARKS.create(EXT, { url: "https://example.org/" });
    expect(node.parentId).toBe(BOOKMARKS_UNFILED);
    expect(node.title).toBe("");
    expect(node.type).toBe("bookmark");
    expect(node.url).toBe("https://example.org/");
    expect(typeof node.id).toBe("string");
    expect(node.id.length).toBeGreaterThan(0);
    expect(typeof node.dateAdded).toBe("number");
    expect(node.index).toBe(0);
  });

  it("create without url makes a folder carrying dateGroupModified", async () => {
    const node = await BOOKMARKS.create(EXT, { title: "Folder", parentId: BOOKMARKS_MENU });
    expect(node.type).toBe("folder");
    expect(node.url).toBeUndefined();
    expect(node.parentId).toBe(BOOKMARKS_MENU);
    expect(typeof node.dateGroupModified).toBe("number");
    expect(node.children).toEqual([]);
  });

  it("create honors an explicit index and re-indexes siblings", async () => {
    const a = await BOOKMARKS.create(EXT, { title: "a", url: "https://a.example/" });
    const b = await BOOKMARKS.create(EXT, { title: "b", url: "https://b.example/" });
    const c = await BOOKMARKS.create(EXT, { title: "c", url: "https://c.example/", index: 1 });
    expect(c.index).toBe(1);
    const kids = await BOOKMARKS.getChildren(EXT, BOOKMARKS_UNFILED);
    expect(kids.map((k) => k.id)).toEqual([a.id, c.id, b.id]);
    expect(kids.map((k) => k.index)).toEqual([0, 1, 2]);
    void b;
  });

  it("create makes separators without url or title", async () => {
    const node = await BOOKMARKS.create(EXT, { type: "separator", title: "ignored" });
    expect(node.type).toBe("separator");
    expect(node.title).toBe("");
    expect(node.url).toBeUndefined();
    await expect(BOOKMARKS.create(EXT, { type: "separator", url: "https://x.example/" })).rejects.toThrow(/separator cannot carry/);
  });

  it("create rejects bad parents, type conflicts, and invalid urls", async () => {
    const folder = await BOOKMARKS.create(EXT, { title: "F" });
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/" });
    /* a bookmark is not a valid parent */
    await expect(BOOKMARKS.create(EXT, { parentId: leaf.id, title: "x", url: "https://x.example/" })).rejects.toThrow(/parentId does not name a folder/);
    await expect(BOOKMARKS.create(EXT, { parentId: folder.id, title: "sub" })).resolves.toBeTruthy(); /* folder in folder is fine */
    await expect(BOOKMARKS.create(EXT, { type: "folder", url: "https://x.example/" })).rejects.toThrow(/folder cannot carry/);
    await expect(BOOKMARKS.create(EXT, { type: "folder" })).resolves.toBeTruthy();
    await expect(BOOKMARKS.create(EXT, { url: "https://x.example/" })).resolves.toBeTruthy();
    await expect(BOOKMARKS.create(EXT, { type: "bookmark" })).rejects.toThrow(/needs a url/);
    await expect(BOOKMARKS.create(EXT, { url: "not a url at all" })).rejects.toThrow(/invalid url/);
    await expect(BOOKMARKS.create(EXT, { parentId: BOOKMARKS_ROOT, title: "x", url: "https://x.example/" })).rejects.toThrow(/under the root/);
    await expect(BOOKMARKS.create(EXT, { parentId: "nosuch_____", title: "x", url: "https://x.example/" })).rejects.toThrow(/parentId does not name a folder/);
    void folder;
  });

  /* ---- get / getChildren / getRecent / getSubTree ------------------- */

  it("get resolves single ids and id lists, and rejects unknown ids", async () => {
    const a = await BOOKMARKS.create(EXT, { title: "a", url: "https://a.example/" });
    const b = await BOOKMARKS.create(EXT, { title: "b", url: "https://b.example/" });
    const got = await BOOKMARKS.get(EXT, [a.id, b.id]);
    expect(got.map((n) => n.id)).toEqual([a.id, b.id]);
    /* shallow form: no children attached */
    expect(got[0].children).toBeUndefined();
    await expect(BOOKMARKS.get(EXT, "nope")).rejects.toThrow(/no bookmark found/);
    await expect(BOOKMARKS.get(EXT, [a.id, "nope"])).rejects.toThrow(/no bookmark found/);
  });

  it("getSubTree returns the deep hierarchy from any node", async () => {
    const folder = await BOOKMARKS.create(EXT, { title: "F", parentId: BOOKMARKS_TOOLBAR });
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/", parentId: folder.id });
    const [sub] = await BOOKMARKS.getSubTree(EXT, BOOKMARKS_TOOLBAR);
    expect(sub.children![0].id).toBe(folder.id);
    expect(sub.children![0].children!.map((c) => c.id)).toEqual([leaf.id]);
    await expect(BOOKMARKS.getSubTree(EXT, "nope")).rejects.toThrow(/no bookmark found/);
  });

  it("getRecent returns the newest nodes first, limited", async () => {
    await BOOKMARKS.create(EXT, { title: "old", url: "https://o.example/" });
    await new Promise((r) => setTimeout(r, 5));
    await BOOKMARKS.create(EXT, { title: "mid", url: "https://m.example/" });
    await new Promise((r) => setTimeout(r, 5));
    await BOOKMARKS.create(EXT, { title: "new", url: "https://n.example/" });
    const recent = await BOOKMARKS.getRecent(EXT, 2);
    expect(recent.map((n) => n.title)).toEqual(["new", "mid"]);
  });

  /* ---- search ------------------------------------------------------- */

  it("search matches word strings against url and title, AND across words", async () => {
    await BOOKMARKS.create(EXT, { title: "Rust docs", url: "https://doc.rust-lang.org/book/" });
    await BOOKMARKS.create(EXT, { title: "Rust crate registry", url: "https://crates.io/" });
    await BOOKMARKS.create(EXT, { title: "News", url: "https://example.org/" });
    const both = await BOOKMARKS.search(EXT, "rust docs");
    expect(both).toHaveLength(1);
    expect(both[0].url).toBe("https://doc.rust-lang.org/book/");
    const urlOnly = await BOOKMARKS.search(EXT, "crates.io");
    expect(urlOnly).toHaveLength(1);
    expect(await BOOKMARKS.search(EXT, "rust nothing-else")).toEqual([]);
  });

  it("search object form filters url and title verbatim", async () => {
    await BOOKMARKS.create(EXT, { title: "Docs", url: "https://example.org/docs" });
    await BOOKMARKS.create(EXT, { title: "Docs", url: "https://mirror.example.org/docs" });
    expect(await BOOKMARKS.search(EXT, { url: "https://example.org/docs" })).toHaveLength(1);
    expect(await BOOKMARKS.search(EXT, { title: "Docs" })).toHaveLength(2);
    expect(await BOOKMARKS.search(EXT, { title: "docs" })).toHaveLength(0); /* verbatim, not case-folded */
    expect(await BOOKMARKS.search(EXT, { query: "DOCS", url: "https://example.org/docs" })).toHaveLength(1); /* query words ARE case-insensitive */
    expect(await BOOKMARKS.search(EXT, {})).toHaveLength(2);
  });

  /* ---- update ------------------------------------------------------- */

  it("update changes title/url and fires onChanged with the new values", async () => {
    const node = await BOOKMARKS.create(EXT, { title: "before", url: "https://before.example/" });
    const seen: Array<{ id: string; info: unknown }> = [];
    BOOKMARKS.onChanged(EXT, (id, info) => seen.push({ id, info }));
    const updated = await BOOKMARKS.update(EXT, node.id, { title: "after", url: "https://after.example/" });
    expect(updated.title).toBe("after");
    expect(updated.url).toBe("https://after.example/");
    expect(seen).toEqual([{ id: node.id, info: { title: "after", url: "https://after.example/" } }]);
  });

  it("update rejects a url on folders and separators, and invalid urls", async () => {
    const folder = await BOOKMARKS.create(EXT, { title: "F" });
    const sep = await BOOKMARKS.create(EXT, { type: "separator" });
    await expect(BOOKMARKS.update(EXT, folder.id, { url: "https://x.example/" })).rejects.toThrow(/only bookmarks carry a url/);
    await expect(BOOKMARKS.update(EXT, sep.id, { url: "https://x.example/" })).rejects.toThrow(/only bookmarks carry a url/);
    await expect(BOOKMARKS.update(EXT, folder.id, { title: "renamed" })).resolves.toBeTruthy();
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/" });
    await expect(BOOKMARKS.update(EXT, leaf.id, { url: "bad url" })).rejects.toThrow(/invalid url/);
    await expect(BOOKMARKS.update(EXT, "nope", { title: "x" })).rejects.toThrow(/no bookmark found/);
  });

  /* ---- move ---------------------------------------------------------- */

  it("move re-parents, fires onMoved with old and new positions, and clamps the index", async () => {
    const a = await BOOKMARKS.create(EXT, { title: "a", url: "https://a.example/" });
    const b = await BOOKMARKS.create(EXT, { title: "b", url: "https://b.example/" });
    const folder = await BOOKMARKS.create(EXT, { title: "F", parentId: BOOKMARKS_TOOLBAR });
    const seen: unknown[] = [];
    BOOKMARKS.onMoved(EXT, (id, info) => seen.push(info));
    const moved = await BOOKMARKS.move(EXT, a.id, { parentId: folder.id });
    expect(moved.parentId).toBe(folder.id);
    expect(moved.index).toBe(0);
    expect(seen).toEqual([{ parentId: folder.id, index: 0, oldParentId: BOOKMARKS_UNFILED, oldIndex: 0 }]);
    const unfiledKids = await BOOKMARKS.getChildren(EXT, BOOKMARKS_UNFILED);
    expect(unfiledKids.map((k) => k.id)).toEqual([b.id]); /* b re-indexed to 0 */
    await BOOKMARKS.move(EXT, b.id, { parentId: folder.id }); /* folder: [a, b] */
    const big = await BOOKMARKS.move(EXT, a.id, { parentId: folder.id, index: 99 });
    expect(big.index).toBe(1); /* clamped to siblings.length */
    const folderKids = await BOOKMARKS.getChildren(EXT, folder.id);
    expect(folderKids.map((k) => k.id)).toEqual([b.id, a.id]);
  });

  it("move reorders within the same folder and fires onMoved", async () => {
    const a = await BOOKMARKS.create(EXT, { title: "a", url: "https://a.example/" });
    const b = await BOOKMARKS.create(EXT, { title: "b", url: "https://b.example/" });
    const c = await BOOKMARKS.create(EXT, { title: "c", url: "https://c.example/" });
    const seen: unknown[] = [];
    BOOKMARKS.onMoved(EXT, (_id, info) => seen.push(info));
    await BOOKMARKS.move(EXT, a.id, { index: 2 });
    const kids = await BOOKMARKS.getChildren(EXT, BOOKMARKS_UNFILED);
    expect(kids.map((k) => k.id)).toEqual([b.id, c.id, a.id]);
    expect(seen).toEqual([{ parentId: BOOKMARKS_UNFILED, index: 2, oldParentId: BOOKMARKS_UNFILED, oldIndex: 0 }]);
    /* a no-op move fires nothing */
    await BOOKMARKS.move(EXT, a.id, { index: 2 });
    expect(seen).toHaveLength(1);
  });

  it("move refuses the root as destination, unknown folders, and its own subtree", async () => {
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/" });
    await expect(BOOKMARKS.move(EXT, leaf.id, { parentId: BOOKMARKS_ROOT })).rejects.toThrow(/into the root/);
    await expect(BOOKMARKS.move(EXT, leaf.id, { parentId: "nope_____" })).rejects.toThrow(/does not name a folder/);
    const folder = await BOOKMARKS.create(EXT, { title: "F" });
    const inner = await BOOKMARKS.create(EXT, { title: "I", parentId: folder.id });
    await expect(BOOKMARKS.move(EXT, folder.id, { parentId: inner.id })).rejects.toThrow(/inside itself/);
    await expect(BOOKMARKS.move(EXT, "nope", { parentId: folder.id })).rejects.toThrow(/no bookmark found/);
  });

  /* ---- remove / removeTree ------------------------------------------- */

  it("remove works on leaves only and fires onRemoved with the node snapshot", async () => {
    const folder = await BOOKMARKS.create(EXT, { title: "F" });
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/", parentId: folder.id });
    await expect(BOOKMARKS.remove(EXT, folder.id)).rejects.toThrow(/not empty/);
    const seen: unknown[] = [];
    BOOKMARKS.onRemoved(EXT, (id, info) => seen.push({ id, info }));
    await BOOKMARKS.remove(EXT, leaf.id);
    expect(seen).toEqual([
      {
        id: leaf.id,
        info: { parentId: folder.id, index: 0, node: { ...leaf, parentId: folder.id } },
      },
    ]);
    await BOOKMARKS.remove(EXT, folder.id); /* now empty, succeeds */
    await expect(BOOKMARKS.remove(EXT, leaf.id)).rejects.toThrow(/no bookmark found/);
    await expect(BOOKMARKS.remove(EXT, BOOKMARKS_ROOT)).rejects.toThrow(/no bookmark found/);
  });

  it("removeTree removes the whole subtree and notifies exactly once", async () => {
    const folder = await BOOKMARKS.create(EXT, { title: "F", parentId: BOOKMARKS_TOOLBAR });
    const inner = await BOOKMARKS.create(EXT, { title: "I", parentId: folder.id });
    const leaf = await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/", parentId: inner.id });
    const seen: unknown[] = [];
    BOOKMARKS.onRemoved(EXT, (id, info) => seen.push({ id, info }));
    await BOOKMARKS.removeTree(EXT, folder.id);
    expect(seen).toHaveLength(1);
    const info = (seen[0] as { info: BookmarkRemoveInfo }).info;
    expect(info.node.parentId).toBe(BOOKMARKS_TOOLBAR);
    expect(info.node.children![0].children![0].id).toBe(leaf.id);
    const toolbar = (await BOOKMARKS.getSubTree(EXT, BOOKMARKS_TOOLBAR))[0];
    expect(toolbar.children).toEqual([]);
  });

  /* ---- events --------------------------------------------------------- */

  it("onCreated fires for folders and bookmarks in the owning extension only", async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    BOOKMARKS.onCreated(EXT, (id) => mine.push(id));
    BOOKMARKS.onCreated(EXT2, (id) => theirs.push(id));
    const node = await BOOKMARKS.create(EXT, { title: "x", url: "https://x.example/" });
    expect(mine).toEqual([node.id]);
    expect(theirs).toEqual([]);
  });

  it("a broken listener cannot break the dispatch", async () => {
    BOOKMARKS.onChanged(EXT, () => {
      throw new Error("boom");
    });
    const node = await BOOKMARKS.create(EXT, { title: "x", url: "https://x.example/" });
    await expect(BOOKMARKS.update(EXT, node.id, { title: "y" })).resolves.toBeTruthy();
  });

  /* ---- persistence (#594 pattern) ------------------------------------- */

  it("the tree survives a registry reset + hydrate", async () => {
    await BOOKMARKS.hydrate(); /* persistence arms only after hydration */
    const folder = await BOOKMARKS.create(EXT, { title: "F", parentId: BOOKMARKS_MENU });
    await BOOKMARKS.create(EXT, { title: "L", url: "https://l.example/", parentId: folder.id });
    await BOOKMARKS.flushForTests();
    BOOKMARKS.resetForTests();
    await BOOKMARKS.hydrate();
    const menu = (await BOOKMARKS.getSubTree(EXT, BOOKMARKS_MENU))[0];
    expect(menu.children![0].title).toBe("F");
    expect(menu.children![0].children![0].url).toBe("https://l.example/");
  });

  it("drop() forgets the extension's tree, as uninstall does", async () => {
    await BOOKMARKS.hydrate();
    await BOOKMARKS.create(EXT, { title: "x", url: "https://x.example/" });
    await BOOKMARKS.flushForTests();
    BOOKMARKS.drop(EXT);
    await BOOKMARKS.flushForTests();
    BOOKMARKS.resetForTests();
    await BOOKMARKS.hydrate();
    const tree = await BOOKMARKS.getTree(EXT);
    expect(tree[0].children!.find((c) => c.id === BOOKMARKS_UNFILED)!.children).toEqual([]);
  });
});
