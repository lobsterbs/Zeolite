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
}

export type MenuClickedListener = (info: MenuClickInfo, tab: unknown) => void;

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

  remove(extId: ExtensionId, id: string): void {
    const list = this.items.get(extId);
    if (!list) return;
    this.items.set(extId, list.filter((x) => x.id !== id));
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

  click(extId: ExtensionId, info: MenuClickInfo, tab: unknown): void {
    const set = this.clickListeners.get(extId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(info, tab);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const MENUS = new ContextMenusHost();
