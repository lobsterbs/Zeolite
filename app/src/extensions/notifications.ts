/* Zeolite extension subsystem: notifications.

   notifications.create() hands the notification to the UI host as a
   zl:notifyOp broadcast (the same handoff shape as downloads); the
   host renders it - LobsterBrowse owns the surface - and reports
   clicks/closes back through zl:notifyEvent, which fires the owning
   extension's events after an idle MV3 background is woken. Until a
   host acts on the op, the notification exists in the registry but
   nothing renders: the compat matrix says exactly that. */

import type { ExtensionId, ExtensionRecord } from "./types";

export interface NotificationButton {
  title: string;
  iconUrl?: string;
}

export interface NotificationRecord {
  extId: ExtensionId;
  id: string;
  title: string;
  message: string;
  iconUrl: string | null;
  buttons: NotificationButton[];
}

export interface NotifyOp {
  op: "create" | "clear";
  extId: ExtensionId;
  id: string;
  /** Present for op:"create": what the host should render. */
  notification?: { title: string; message: string; iconUrl: string | null; buttons: NotificationButton[] };
}

export type NotifyEventKind = "clicked" | "closed" | "buttonClicked";

export type NotificationClickedListener = (id: string) => void;
export type NotificationClosedListener = (id: string, byUser: boolean) => void;
export type ButtonClickedListener = (id: string, buttonIndex: number) => void;

const MAX_BUTTONS = 2;

export class NotificationsHost {
  private seq = 0;
  private dispatch: ((op: NotifyOp) => void) | null = null;
  private readonly notes = new Map<string, NotificationRecord>();
  private readonly clicked = new Map<ExtensionId, Set<NotificationClickedListener>>();
  private readonly closed = new Map<ExtensionId, Set<NotificationClosedListener>>();
  private readonly buttonClicked = new Map<ExtensionId, Set<ButtonClickedListener>>();

  setDispatch(fn: ((op: NotifyOp) => void) | null): void {
    this.dispatch = fn;
  }

  create(ext: ExtensionRecord, id: unknown, opts: Record<string, unknown>): Promise<string> {
    if (!ext.permissions.includes("notifications")) {
      return Promise.reject(
        new Error("zeolite: permission 'notifications' not granted to this extension"),
      );
    }
    if (!opts || typeof opts.title !== "string" || typeof opts.message !== "string") {
      return Promise.reject(new Error("zeolite: notifications.create requires title and message"));
    }
    const nid = typeof id === "string" && id.length > 0 ? id : "n" + ++this.seq;
    const rec: NotificationRecord = {
      extId: ext.id,
      id: nid,
      title: opts.title,
      message: opts.message,
      iconUrl: typeof opts.iconUrl === "string" ? opts.iconUrl : null,
      buttons: (Array.isArray(opts.buttons) ? opts.buttons : [])
        .slice(0, MAX_BUTTONS)
        .map((b) => b as Record<string, unknown>)
        .filter((b) => typeof b.title === "string")
        .map((b) => ({
          title: String(b.title),
          ...(typeof b.iconUrl === "string" ? { iconUrl: b.iconUrl } : {}),
        })),
    };
    this.notes.set(nid, rec);
    this.dispatch?.({
      op: "create",
      extId: ext.id,
      id: nid,
      notification: {
        title: rec.title,
        message: rec.message,
        iconUrl: rec.iconUrl,
        buttons: rec.buttons,
      },
    });
    return Promise.resolve(nid);
  }

  /** Re-render an existing notification with new options; false when
      the id is unknown or belongs to another extension. */
  update(ext: ExtensionRecord, id: string, opts: Record<string, unknown>): Promise<boolean> {
    const rec = this.owned(ext, id);
    if (!rec) return Promise.resolve(false);
    if (opts && typeof opts.title === "string") rec.title = opts.title;
    if (opts && typeof opts.message === "string") rec.message = opts.message;
    if (opts && typeof opts.iconUrl === "string") rec.iconUrl = opts.iconUrl;
    this.dispatch?.({
      op: "create",
      extId: ext.id,
      id,
      notification: { title: rec.title, message: rec.message, iconUrl: rec.iconUrl, buttons: rec.buttons },
    });
    return Promise.resolve(true);
  }

  clear(ext: ExtensionRecord, id: string): Promise<boolean> {
    const rec = this.owned(ext, id);
    if (!rec) return Promise.resolve(false);
    this.notes.delete(id);
    this.dispatch?.({ op: "clear", extId: ext.id, id });
    return Promise.resolve(true);
  }

  getAll(ext: ExtensionRecord): Promise<Record<string, { title: string; message: string }>> {
    const out: Record<string, { title: string; message: string }> = {};
    for (const [id, rec] of this.notes) {
      if (rec.extId === ext.id) out[id] = { title: rec.title, message: rec.message };
    }
    return Promise.resolve(out);
  }

  /** Registry view for the host/UI; one extension's own entries. */
  listFor(extId: ExtensionId): NotificationRecord[] {
    return [...this.notes.values()].filter((n) => n.extId === extId).map((n) => ({ ...n }));
  }

  /** Existence + ownership check for the zl:notifyEvent reply. */
  exists(extId: string, id: string): boolean {
    const rec = this.notes.get(id);
    return !!rec && rec.extId === extId;
  }

  private owned(ext: ExtensionRecord, id: string): NotificationRecord | null {
    const rec = this.notes.get(id);
    return rec && rec.extId === ext.id ? rec : null;
  }

  onClicked(extId: ExtensionId, l: NotificationClickedListener): () => void {
    return this.sub(this.clicked, extId, l);
  }

  onClosed(extId: ExtensionId, l: NotificationClosedListener): () => void {
    return this.sub(this.closed, extId, l);
  }

  onButtonClicked(extId: ExtensionId, l: ButtonClickedListener): () => void {
    return this.sub(this.buttonClicked, extId, l);
  }

  private sub<L>(map: Map<ExtensionId, Set<L>>, extId: ExtensionId, l: L): () => void {
    let set = map.get(extId);
    if (!set) {
      set = new Set();
      map.set(extId, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** zl:notifyEvent: a host-reported interaction. Validates the
      entry and ownership, fires the matching listeners, and removes
      the entry on close. Returns false when nothing matched. */
  event(extId: string, id: string, kind: NotifyEventKind, buttonIndex?: number): boolean {
    const rec = this.notes.get(id);
    if (!rec || rec.extId !== extId) return false;
    const fire = <L>(map: Map<ExtensionId, Set<L>>, ...args: unknown[]) => {
      const set = map.get(extId);
      if (!set) return;
      for (const l of [...set]) {
        try {
          (l as (...a: unknown[]) => void)(...args);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }
    };
    if (kind === "clicked") fire(this.clicked, id);
    else if (kind === "buttonClicked") fire(this.buttonClicked, id, buttonIndex ?? 0);
    else {
      fire(this.closed, id, true);
      this.notes.delete(id);
    }
    return true;
  }
}

export const NOTIFY = new NotificationsHost();
