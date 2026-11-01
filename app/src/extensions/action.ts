/* Zeolite extension subsystem: toolbar action registries.

   browser.action (MV3) and browser.browserAction / browser.pageAction
   (MV2) over one per-extension, per-tab state registry, following the
   notifications handoff shape: state changes broadcast to the host UI
   as a zl:actionOp (the host renders badge/title/icon/popup -
   LobsterBrowse owns the surface) and clicks come back through
   zl:actionEvent, which fires the owning extension's onClicked after
   an idle MV3 background is woken. Until a host acts on the ops the
   registry is the source of truth and nothing renders: the compat
   matrix says exactly that.

   Semantics follow Firefox: every setter takes an optional tabId and
   falls back to the manifest defaults for the keys never set; a
   per-tab state always wins over the default state; pageAction starts
   hidden and only show(tabId) makes it clickable on that tab. The
   registry is in-memory and dies with the worker, like alarms. */

import type { ExtensionId, ExtensionRecord } from "./types";
import { normalizeExtensionPath } from "./origin";

export type ActionKind = "action" | "browser_action" | "page_action";

export interface ActionState {
  title: string | null;
  badgeText: string | null;
  badgeBackgroundColor: [number, number, number, number] | null;
  badgeTextColor: [number, number, number, number] | null;
  popup: string | null;
  iconPaths: Record<string, string> | null;
  enabled: boolean;
}

export interface ActionOp {
  op: "state";
  extId: ExtensionId;
  kind: ActionKind;
  /** null = the default (all-tabs) state changed. */
  tabId: number | null;
  state: ActionState;
}

export interface ActionClick {
  tabId: number;
  button?: number;
  modifiers?: string[];
  /** The permission-gated Tab view resolved by the control plane from
      the tabs bridge; absent when no tab model entry matched. */
  tab?: unknown;
}

export type ActionClickedListener = (click: ActionClick) => void;

/** Color detail normalizer shared by badge background/text: a #rrggbb
    string or an [r,g,b,(a)] array; Firefox answers [r,g,b,a]. */
function colorOf(v: unknown): [number, number, number, number] | null | "invalid" {
  if (typeof v === "string") {
    const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
    if (!m) return "invalid";
    const hex = m[1].length === 3
      ? m[1].split("").map((c) => c + c).join("")
      : m[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255,
    ];
  }
  if (Array.isArray(v)) {
    /* Strict shape: exactly 3 or 4 entries, every entry a number —
       malformed arrays are rejected, never silently coerced. */
    if (v.length !== 3 && v.length !== 4) return "invalid";
    if (!v.every((x) => typeof x === "number")) return "invalid";
    const n = v as number[];
    if (n.some((x) => x < 0 || x > 255)) return "invalid";
    return [n[0], n[1], n[2], n.length === 4 ? n[3] : 255];
  }
  return "invalid";
}

/** Package-relative path check for popup and icon paths; null clears.
    Anything that is not a safe relative package path is a Firefox-style
    type error, not silently coerced. */
function popupPathOf(v: unknown): string | null | "invalid" {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return "invalid";
  const norm = normalizeExtensionPath(v.startsWith("/") ? v : "/" + v);
  return norm === null ? "invalid" : norm;
}

interface KindEntry {
  defaults: ActionState;
  tabs: Map<number, ActionState>;
}

export class ActionHost {
  private dispatch: ((op: ActionOp) => void) | null = null;
  private readonly kinds = new Map<string, KindEntry>();
  private readonly clicked = new Map<string, Set<ActionClickedListener>>();

  setDispatch(fn: ((op: ActionOp) => void) | null): void {
    this.dispatch = fn;
  }

  /** One registry per (extension, kind); the manifest spec seeds the
      defaults exactly as Firefox seeds them from default_title,
      default_icon and default_popup. page_action defaults to hidden. */
  private entry(ext: ExtensionRecord, kind: ActionKind): KindEntry {
    const key = ext.id + "|" + kind;
    let e = this.kinds.get(key);
    if (!e) {
      const spec = ext.action && ext.action.kind === kind ? ext.action : null;
      e = {
        defaults: {
          title: spec?.defaultTitle ?? null,
          badgeText: null,
          badgeBackgroundColor: null,
          badgeTextColor: null,
          popup: spec?.defaultPopup
            ? normalizeExtensionPath(
                spec.defaultPopup.startsWith("/") ? spec.defaultPopup : "/" + spec.defaultPopup,
              )
            : null,
          iconPaths: spec && Object.keys(spec.defaultIcon).length > 0 ? { ...spec.defaultIcon } : null,
          enabled: kind !== "page_action",
        },
        tabs: new Map(),
      };
      this.kinds.set(key, e);
    }
    return e;
  }

  /** Resolve the effective state for a tab: the per-tab overrides over
      the defaults, keyed the way Firefox resolves them. */
  private effective(entry: KindEntry, tabId?: number | null): ActionState {
    const base = { ...entry.defaults };
    const over = tabId === undefined || tabId === null ? null : entry.tabs.get(tabId);
    if (!over) return base;
    const merged = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v !== null && v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
    }
    return merged;
  }

  /** A per-tab change only stores the keys that actually differ from
      the defaults, so later default changes still show through. */
  private apply(
    ext: ExtensionRecord,
    kind: ActionKind,
    tabId: number | null | undefined,
    patch: Partial<ActionState>,
  ): ActionState {
    const entry = this.entry(ext, kind);
    let target: ActionState;
    if (tabId === undefined || tabId === null) {
      Object.assign(entry.defaults, patch);
      target = { ...entry.defaults };
    } else {
      const current = this.effective(entry, tabId);
      Object.assign(current, patch);
      /* TS keyof-write limitation: build the diff as a plain record
         (keys come from Object.keys(current)) and cast to the state
         shape at the registry boundary. */
      const over: Record<string, unknown> = {};
      for (const k of Object.keys(current) as Array<keyof ActionState>) {
        if (current[k] !== entry.defaults[k]) over[k] = current[k];
      }
      entry.tabs.set(tabId, over as unknown as ActionState);
      target = current;
    }
    this.dispatch?.({
      op: "state",
      extId: ext.id,
      kind,
      tabId: tabId ?? null,
      state: target,
    });
    return target;
  }

  /** Registry view for the host UI; enabled extensions only. */
  listFor(extId: ExtensionId): Array<{ extId: ExtensionId; kind: ActionKind; defaults: ActionState }> {
    const out: Array<{ extId: ExtensionId; kind: ActionKind; defaults: ActionState }> = [];
    for (const [key, e] of this.kinds) {
      const [id, kind] = key.split("|") as [ExtensionId, ActionKind];
      if (id !== extId) continue;
      out.push({ extId: id, kind, defaults: { ...e.defaults } });
    }
    return out;
  }

  /** Seed the (extension, kind) entry at namespace mount so the host
      receives the initial state op and get* answers exist before any
      setter runs. */
  touch(ext: ExtensionRecord, kind: ActionKind): ActionState {
    return { ...this.entry(ext, kind).defaults };
  }

  /** The popup the host should open for the toolbar/page menu; the
      per-tab state for the active tab wins over the default. */
  popupFor(ext: ExtensionRecord, kind: ActionKind, tabId?: number | null): string | null {
    return this.effective(this.entry(ext, kind), tabId ?? null).popup;
  }

  isEnabled(ext: ExtensionRecord, kind: ActionKind, details?: { tabId?: number | null }): boolean {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).enabled;
  }

  getTitle(ext: ExtensionRecord, kind: ActionKind, details?: { tabId?: number | null }): string | null {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).title;
  }

  getBadgeText(ext: ExtensionRecord, kind: ActionKind, details?: { tabId?: number | null }): string | null {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).badgeText;
  }

  getBadgeBackgroundColor(
    ext: ExtensionRecord,
    kind: ActionKind,
    details?: { tabId?: number | null },
  ): [number, number, number, number] | null {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).badgeBackgroundColor;
  }

  getBadgeTextColor(
    ext: ExtensionRecord,
    kind: ActionKind,
    details?: { tabId?: number | null },
  ): [number, number, number, number] | null {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).badgeTextColor;
  }

  getPopup(ext: ExtensionRecord, kind: ActionKind, details?: { tabId?: number | null }): string | null {
    return this.effective(this.entry(ext, kind), details?.tabId ?? null).popup;
  }

  setTitle(ext: ExtensionRecord, kind: ActionKind, details: { title?: unknown; tabId?: number | null }): void {
    const t = details.title === null ? null : typeof details.title === "string" ? details.title : undefined;
    if (t === undefined) throw new Error("zeolite: setTitle requires a string or null title");
    this.apply(ext, kind, details.tabId, { title: t });
  }

  setBadgeText(ext: ExtensionRecord, kind: ActionKind, details: { text?: unknown; tabId?: number | null }): void {
    const t = details.text === null || details.text === "" ? null : typeof details.text === "string" ? details.text : undefined;
    if (t === undefined) throw new Error("zeolite: setBadgeText requires a string or null text");
    this.apply(ext, kind, details.tabId, { badgeText: t });
  }

  private setBadgeColor(
    ext: ExtensionRecord,
    kind: ActionKind,
    key: "badgeBackgroundColor" | "badgeTextColor",
    details: { color?: unknown; tabId?: number | null },
  ): void {
    const c = colorOf(details.color);
    if (c === "invalid") throw new Error("zeolite: badge color must be a #rrggbb string or an [r,g,b(,a)] array");
    this.apply(ext, kind, details.tabId, { [key]: c } as Partial<ActionState>);
  }

  setBadgeBackgroundColor(ext: ExtensionRecord, kind: ActionKind, details: { color?: unknown; tabId?: number | null }): void {
    this.setBadgeColor(ext, kind, "badgeBackgroundColor", details);
  }

  setBadgeTextColor(ext: ExtensionRecord, kind: ActionKind, details: { color?: unknown; tabId?: number | null }): void {
    this.setBadgeColor(ext, kind, "badgeTextColor", details);
  }

  setPopup(ext: ExtensionRecord, kind: ActionKind, details: { popup?: unknown; tabId?: number | null }): void {
    const p = popupPathOf(details.popup);
    if (p === "invalid") throw new Error("zeolite: setPopup requires a package-relative path or null");
    this.apply(ext, kind, details.tabId, { popup: p });
  }

  /** Icon paths only: ImageData payloads have no honest worker-side
      rendering path here, so they are refused instead of faked. */
  setIcon(ext: ExtensionRecord, kind: ActionKind, details: { path?: unknown; tabId?: number | null }): void {
    if (typeof details.path === "string") {
      const norm = popupPathOf(details.path);
      if (norm === "invalid" || norm === null) throw new Error("zeolite: setIcon path must be a package-relative path");
      this.apply(ext, kind, details.tabId, { iconPaths: { "38": norm } });
      return;
    }
    if (details.path !== null && typeof details.path === "object" && !Array.isArray(details.path)) {
      const out: Record<string, string> = {};
      for (const [size, p] of Object.entries(details.path as Record<string, unknown>)) {
        const norm = popupPathOf(p);
        if (norm === "invalid" || norm === null) {
          throw new Error("zeolite: setIcon path for size " + size + " must be a package-relative path");
        }
        out[size] = norm;
      }
      this.apply(ext, kind, details.tabId, { iconPaths: Object.keys(out).length > 0 ? out : null });
      return;
    }
    throw new Error("zeolite: setIcon requires a path string or size map (ImageData is not supported)");
  }

  enable(ext: ExtensionRecord, kind: ActionKind, tabId?: number | null): void {
    this.apply(ext, kind, tabId, { enabled: true });
  }

  disable(ext: ExtensionRecord, kind: ActionKind, tabId?: number | null): void {
    this.apply(ext, kind, tabId, { enabled: false });
  }

  /** pageAction.show(tabId): the tabId is required in Firefox and the
      API has no default-state form. */
  show(ext: ExtensionRecord, tabId: number): void {
    if (typeof tabId !== "number") throw new Error("zeolite: pageAction.show requires a tabId");
    this.apply(ext, "page_action", tabId, { enabled: true });
  }

  hide(ext: ExtensionRecord, tabId: number): void {
    if (typeof tabId !== "number") throw new Error("zeolite: pageAction.hide requires a tabId");
    this.apply(ext, "page_action", tabId, { enabled: false });
  }

  isShown(ext: ExtensionRecord, details?: { tabId?: number | null }): boolean {
    return this.isEnabled(ext, "page_action", details);
  }

  onClicked(extId: ExtensionId, kind: ActionKind, l: ActionClickedListener): () => void {
    const key = extId + "|" + kind;
    let set = this.clicked.get(key);
    if (!set) {
      set = new Set();
      this.clicked.set(key, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** zl:actionEvent: a host-reported toolbar click. The entry must
      exist and belong to the named extension; ownership of the click
      kind is the host's (it rendered the button). Returns false when
      nothing matched. */
  click(extId: string, kind: ActionKind, info: ActionClick): boolean {
    const key = extId + "|" + kind;
    const set = this.clicked.get(key);
    if (!set) return false;
    for (const l of [...set]) {
      try {
        l(info);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    return true;
  }

  /** Uninstall cleanup (manager.uninstall, next to ALARMS.drop). */
  drop(extId: ExtensionId): void {
    for (const key of [...this.kinds.keys()]) {
      if (key.startsWith(extId + "|")) this.kinds.delete(key);
    }
    for (const key of [...this.clicked.keys()]) {
      if (key.startsWith(extId + "|")) this.clicked.delete(key);
    }
  }
}

export const ACTION = new ActionHost();
