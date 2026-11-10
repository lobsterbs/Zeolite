/* Zeolite extension subsystem: devtools.* (#523).

   The devtools_page boots through the standard extension-page flow:
   the host opens it with zl:openExtPage which:"devtools" carrying the
   inspected tab id, the granted navigation's page token binds the
   client as a devtools page (serve.ts), and the page bridge learns
   its inspectedWindow.tabId from the served config. The SW-side calls
   verify the binding independently: a client that is not a registered
   devtools page of THIS extension gets nothing.

   inspectedWindow.eval rides the scripting execution channel and its
   permission boundary (see ./scripting). panels.create registers the
   panel and hands it to the host UI over zl:devtoolsOp; the visible
   panel surface ships with the LobsterBrowse integration. Panel
   events (onShown/onSearch) and devtools.network are not delivered to
   the page in this pass (documented in ./compat). */

import { SCRIPTING } from "./scripting";
import { TABS } from "./tabs";
import type { ExtensionRecord } from "./types";

export interface DevtoolsBinding {
  extId: string;
  tabId: number;
}

/* Devtools page clients, keyed by the SW-observed client id of the
   granted navigation. ponytail: no TTL, the SW's own lifetime bounds
   the map; a stale entry after the page closes is inert because
   client ids are never reassigned. */
const devtoolsClients = new Map<string, DevtoolsBinding>();

export function registerDevtoolsClient(clientId: string | undefined, extId: string, tabId: number): void {
  if (clientId && Number.isInteger(tabId)) devtoolsClients.set(clientId, { extId, tabId });
}

export function devtoolsBindingOf(clientId: string | undefined): DevtoolsBinding | null {
  return clientId ? (devtoolsClients.get(clientId) ?? null) : null;
}

export function devtoolsTabOf(clientId: string | undefined): number | null {
  const b = devtoolsBindingOf(clientId);
  return b ? b.tabId : null;
}

/* Panels created by devtools pages, pending the host panel surface.
   Cap 256 with oldest eviction: an unbounded map behind a host
   handoff is a leak, and a registry this small never needs more. */
export interface DevtoolsPanel {
  id: string;
  extId: string;
  clientId: string;
  tabId: number;
  title: string;
  iconPath: string | null;
  pagePath: string;
}

const panels = new Map<string, DevtoolsPanel>();
const PANEL_CAP = 256;

export type DevtoolsOp =
  | {
      type: "createPanel";
      extId: string;
      tabId: number;
      panelId: string;
      title: string;
      iconPath: string | null;
      pagePath: string;
    };

class DevtoolsHost {
  private dispatch: ((op: DevtoolsOp) => void) | null = null;

  setDispatch(fn: ((op: DevtoolsOp) => void) | null): void {
    this.dispatch = fn;
  }

  private binding(rec: ExtensionRecord, clientId: string | undefined): DevtoolsBinding {
    const b = devtoolsBindingOf(clientId);
    if (!b || b.extId !== rec.id) {
      throw new Error("zeolite: devtools APIs are only available to a devtools page of this extension");
    }
    return b;
  }

  async handleDevtoolsCall(
    rec: ExtensionRecord,
    clientId: string | undefined,
    path: string[],
    args: unknown[],
  ): Promise<{ ok: boolean; response?: unknown; error?: string }> {
    try {
      const ns = path[1] ?? "";
      const op = path[2] ?? "";
      if (ns === "inspectedWindow" && op === "eval") {
        const b = this.binding(rec, clientId);
        const opts = args[1];
        const evalInFunction =
          typeof opts === "object" && opts !== null && (opts as Record<string, unknown>).evalInFunction === true;
        try {
          const result = await SCRIPTING.evalExpression(rec, b.tabId, String(args[0]), evalInFunction);
          return { ok: true, response: result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (ns === "inspectedWindow" && op === "reload") {
        const b = this.binding(rec, clientId);
        const tab = TABS.get(b.tabId);
        if (!tab) return { ok: false, error: "Invalid tab ID: " + b.tabId };
        /* ignoreCache is accepted and recorded; the engine re-navigates
           through its own pipeline, which owns cache semantics. */
        await TABS.update(b.tabId, { url: tab.url });
        return { ok: true };
      }
      if (ns === "panels" && op === "create") {
        const b = this.binding(rec, clientId);
        const title = args[0];
        const pagePath = args[2];
        if (typeof title !== "string" || title === "") {
          return { ok: false, error: "zeolite: panels.create requires a title" };
        }
        if (typeof pagePath !== "string" || pagePath === "") {
          return { ok: false, error: "zeolite: panels.create requires a page path" };
        }
        const iconPath = typeof args[1] === "string" && args[1] !== "" ? (args[1] as string) : null;
        if (panels.size >= PANEL_CAP) {
          const oldest = panels.keys().next().value;
          if (oldest !== undefined) panels.delete(oldest);
        }
        const id = crypto.randomUUID();
        panels.set(id, { id, extId: rec.id, clientId: clientId ?? "", tabId: b.tabId, title, iconPath, pagePath });
        this.dispatch?.({ type: "createPanel", extId: rec.id, tabId: b.tabId, panelId: id, title, iconPath, pagePath });
        /* The Panel's event objects cannot cross the structured-clone
           RPC channel; the page gets the identity, the host gets the
           handoff (compat.ts documents the event residual). */
        return { ok: true, response: { id, title } };
      }
      return { ok: false, error: "no such api: devtools." + ns + (op ? "." + op : "") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const DEVTOOLS = new DevtoolsHost();
