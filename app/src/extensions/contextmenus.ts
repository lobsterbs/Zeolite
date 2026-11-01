/* Zeolite extension subsystem: contextMenus (and the menus alias).

   The registry is real: extensions register items, and clicks
   arrive from the UI host through the zl:menuClick control message,
   which resolves the page's tab through the tabs bridge before
   delivery. The host lists the registry through zl:listMenus (#45)
   so it can render the real surface. The visible menu UI ships with
   the LobsterBrowse integration; until then items register but no
   menu renders, and the compat matrix says exactly that. */

import type { ExtensionId, ExtensionRecord } from "./types";

export interface MenuItem {
  extId: ExtensionId;
  id: string;
  title: string;
  contexts: string[];
  enabled: boolean;
  /** #45: nesting parent within the same extension, or null. */
  parentId: string | null;
  /** "normal" | "checkbox" | "radio" | "separator". */
  type: string;
  /** Checkbox/radio initial state; false for normal/separator. */
  checked: boolean;
}

export interface MenuClickInfo {
  menuItemId: string;
  pageUrl: string;
  /** #519: enrichment from the host report + registry state. Firefox's
      OnClickData carries these when applicable; the registry only
      forwards fields the host actually sent, with type validation. */
  parentId?: string;
  checked?: boolean;
  wasChecked?: boolean;
  modifiers?: string[];
  selectionText?: string;
  linkUrl?: string;
  srcUrl?: string;
  mediaType?: string;
  frameUrl?: string;
  documentUrl?: string;
  frameId?: number;
  editable?: boolean;
}

export type MenuClickedListener = (info: MenuClickInfo, tab: unknown) => void;

/** Firefox's OnClickData modifier vocabulary; anything else in the
    host report is dropped rather than delivered. */
const MENU_MODIFIERS = new Set(["Command", "Ctrl", "Shift", "Alt", "MacCtrl"]);

const MENU_STRING_FIELDS = [
  "selectionText",
  "linkUrl",
  "srcUrl",
  "mediaType",
  "frameUrl",
  "documentUrl",
] as const;

const MAX_ITEMS = 64;

export class ContextMenusHost {
  private readonly items = new Map<ExtensionId, MenuItem[]>();
  private readonly clickListeners = new Map<ExtensionId, Set<MenuClickedListener>>();
  private seq = 0;

  create(ext: ExtensionRecord, props: Record<string, unknown>): string | number {
    if (!ext.permissions.includes("contextMenus") && !ext.permissions.includes("menus")) {
      throw new Error("zeolite: permission 'contextMenus' not granted to this extension");
    }
    const title = String(props.title ?? "");
    const contexts = Array.isArray(props.contexts) ? props.contexts.map(String) : ["page"];
    const id = typeof props.id === "string" ? props.id : ++this.seq;
    let list = this.items.get(ext.id);
    if (!list) {
      list = [];
      this.items.set(ext.id, list);
    }
    /* #45: parentId/type/checked round-trip through the registry so
       the host listing (zl:listMenus) can render the real shape. The
       parent must already exist in this extension's own items. */
    const parentId = props.parentId == null ? null : String(props.parentId);
    if (parentId !== null && !list.some((x) => x.id === parentId)) {
      throw new Error("zeolite: menus.create parentId not found for this extension");
    }
    /* #519: Firefox rejects a duplicate id in the same extension's
       item space instead of silently shadowing the first item. */
    if (list.some((x) => x.id === String(id))) {
      throw new Error("zeolite: menus.create duplicate id '" + String(id) + "' for this extension");
    }
    const type =
      props.type === "checkbox" || props.type === "radio" || props.type === "separator"
        ? props.type
        : "normal";
    if (list.length >= MAX_ITEMS) throw new Error("zeolite: too many menu items");
    list.push({
      extId: ext.id,
      id: String(id),
      title,
      contexts,
      enabled: true,
      parentId,
      type,
      checked: type === "checkbox" || type === "radio" ? props.checked === true : false,
    });
    return id;
  }

  /** #519: Firefox menus.update - merge the given properties into the
      item; unknown ids reject. parentId must exist and re-rooting
      cannot create a cycle. type/checked follow Firefox: switching a
      normal item to checkbox/radio adopts the given checked state. */
  update(extId: ExtensionId, id: string, props: Record<string, unknown>): void {
    const list = this.items.get(extId);
    const item = list?.find((x) => x.id === id);
    if (!item) throw new Error("zeolite: menus.update: no item with id '" + id + "' for this extension");
    if (props.title !== undefined) item.title = String(props.title);
    if (props.contexts !== undefined) {
      if (!Array.isArray(props.contexts)) {
        throw new Error("zeolite: menus.update: contexts must be an array");
      }
      item.contexts = props.contexts.map(String);
    }
    if (props.enabled !== undefined) item.enabled = props.enabled === true;
    if (props.type !== undefined) {
      if (props.type !== "normal" && props.type !== "checkbox" && props.type !== "radio" && props.type !== "separator") {
        throw new Error("zeolite: menus.update: unknown type '" + String(props.type) + "'");
      }
      item.type = props.type;
      if (item.type === "normal" || item.type === "separator") item.checked = false;
    }
    if (props.checked !== undefined) {
      if (item.type !== "checkbox" && item.type !== "radio") {
        throw new Error("zeolite: menus.update: checked only applies to checkbox/radio items");
      }
      item.checked = props.checked === true;
    }
    if (props.parentId !== undefined) {
      const parentId = props.parentId == null ? null : String(props.parentId);
      if (parentId === id) throw new Error("zeolite: menus.update: an item cannot be its own parent");
      if (parentId !== null) {
        const parent = list!.find((x) => x.id === parentId);
        if (!parent) throw new Error("zeolite: menus.update: parentId not found for this extension");
        /* Walk to the root: re-parenting under a descendant would
           orphan a cycle into the registry. */
        let cursor: string | null = parent.parentId;
        while (cursor !== null) {
          if (cursor === id) throw new Error("zeolite: menus.update: cannot re-parent under a descendant");
          cursor = list!.find((x) => x.id === cursor)?.parentId ?? null;
        }
      }
      item.parentId = parentId;
    }
  }

  /** #519: Firefox remove semantics - an unknown id rejects (Chrome
      reports the error through lastError), and removing a parent
      removes its whole subtree. */
  remove(extId: ExtensionId, id: string): void {
    const list = this.items.get(extId);
    if (!list || !list.some((x) => x.id === id)) {
      throw new Error("zeolite: menus.remove: no item with id '" + id + "' for this extension");
    }
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of list) {
        if (x.parentId !== null && doomed.has(x.parentId) && !doomed.has(x.id)) {
          doomed.add(x.id);
          grew = true;
        }
      }
    }
    this.items.set(extId, list.filter((x) => !doomed.has(x.id)));
  }

  removeAll(extId: ExtensionId): void {
    this.items.delete(extId);
  }

  itemsFor(extId: ExtensionId): MenuItem[] {
    return [...(this.items.get(extId) ?? [])];
  }

  onClicked(extId: ExtensionId, l: MenuClickedListener): () => void {
    let set = this.clickListeners.get(extId);
    if (!set) {
      set = new Set();
      this.clickListeners.set(extId, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** #519: click delivery with Firefox state semantics - checkboxes
      toggle, radios take exclusive checked state within the same
      parent, and the OnClickData info carries the resulting
      checked/wasChecked plus the validated host-reported fields. */
  click(extId: ExtensionId, info: MenuClickInfo, tab: unknown): void {
    const list = this.items.get(extId);
    const item = list?.find((x) => x.id === info.menuItemId);
    const out: MenuClickInfo = { menuItemId: info.menuItemId, pageUrl: info.pageUrl };
    if (item) {
      if (item.parentId !== null) out.parentId = item.parentId;
      if (item.type === "checkbox" || item.type === "radio") {
        const wasChecked = item.checked;
        const newChecked = item.type === "radio" ? true : !wasChecked;
        item.checked = newChecked;
        if (item.type === "radio" && newChecked) {
          for (const sib of list!) {
            if (sib !== item && sib.type === "radio" && sib.parentId === item.parentId) sib.checked = false;
          }
        }
        out.checked = newChecked;
        out.wasChecked = wasChecked;
      }
    }
    const raw = info as unknown as Record<string, unknown>;
    if (Array.isArray(info.modifiers)) {
      const mods = info.modifiers.filter((m) => typeof m === "string" && MENU_MODIFIERS.has(m));
      if (mods.length > 0) out.modifiers = mods;
    }
    for (const f of MENU_STRING_FIELDS) {
      const v = raw[f];
      if (typeof v === "string") (out as unknown as Record<string, unknown>)[f] = v;
    }
    if (typeof info.frameId === "number" && Number.isInteger(info.frameId) && info.frameId >= 0) {
      out.frameId = info.frameId;
    }
    if (typeof info.editable === "boolean") out.editable = info.editable;
    const set = this.clickListeners.get(extId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(out, tab);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const MENUS = new ContextMenusHost();
