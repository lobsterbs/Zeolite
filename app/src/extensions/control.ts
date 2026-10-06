/* Extension control facade: extension-facing zl: dispatch plus the
 * content-script bridge handler (issue #91). */

import { decodePath } from "../codec";
import type { ControlMessage } from "../control";
import { bootInstalled, wakeExtension } from "./background";
import { contentScriptMatches } from "./content-scripts";
import { MESSENGER, getExtensionContext } from "./context";
import { MENUS } from "./contextmenus";
import { DOWNLOADS } from "./downloads";
import { extensions } from "./manager";
import { NOTIFY } from "./notifications";
import { normalizeExtensionPath } from "./origin";
import { handleExtPageCall } from "./pageapi";
import { EXT_ROUTE, mintPageToken, pageClientOf } from "./serve";
import type { ExtensionStorageArea } from "./storage";
import { TABS, tabView } from "./tabs";
import { WEBNAV } from "./webnavigation";

export interface ExtCtx {
  e: ExtendableMessageEvent;
  reply: (data: any) => void;
}

export async function dispatchExtControl(msg: ControlMessage, ctx: ExtCtx): Promise<void> {
  const { e, reply } = ctx;
  switch (msg?.type) {
    case "zl:downloadState": {
      /* #44: the UI host reports a zl:downloadOp handoff's progress
         or outcome (normally fire-and-forget, no reply port; a port
         gets the acknowledgement). Terminal states are final: later
         reports for the same id are refused. Delivery wakes the
         owning extension's background first, same as menu clicks. */
      const ds = msg as { id?: unknown; status?: unknown; received?: unknown; size?: unknown; error?: unknown };
      const applied =
        typeof ds.id === "number" && typeof ds.status === "string"
          ? DOWNLOADS.applyState(ds.id, ds.status, ds)
          : null;
      if (!applied) {
        reply({ ok: false, error: "unknown or finished download id" });
        break;
      }
      e.waitUntil(
        wakeExtension(applied.extId).then(() => DOWNLOADS.notify(applied.extId, applied.delta)),
      );
      reply({ ok: true });
      break;
    }
    case "zl:ext": {
      /* Content-script bridge traffic from a controlled page. Real
         host verification: the sender page's destination must match
         the extension's declared content-script patterns. */
      const em = msg as { extId?: string; msg?: unknown };
      const extId = em.extId;
      if (!extId) {
        reply({ ok: false, error: "missing extId" });
        break;
      }
      e.waitUntil(
        handleExtMessage(e, { extId, msg: em.msg }).then(
          (r) => reply(r),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:tabs": {
      /* Authoritative tab list from the UI. The registry diffs it,
         fires tab events, and resolves pending extension ops. */
      if (!Array.isArray(msg.tabs)) {
        reply({ ok: false, error: "missing tabs" });
        break;
      }
      TABS.syncFromUi(msg.tabs);
      reply({ ok: true });
      break;
    }
    case "zl:listExt": {
      /* UI -> SW: the extensions toolbar panel wants the installed
         list. Summary only: no manifest, no permissions, no paths. */
      reply({
        ok: true,
        extensions: extensions.list().map((r) => ({
          id: r.id,
          name: r.name,
          version: r.version,
          state: r.state,
          enabled: r.enabled,
          lastError: r.lastError,
        })),
      });
      break;
    }
    case "zl:installExt": {
      /* UI -> SW: install a packaged extension. The manager owns every
         validation (zip limits, manifest parse, permission grants);
         a bad package lands that extension in ERROR, not the host. */
      const em = msg as { bytes?: Uint8Array };
      if (!(em.bytes instanceof Uint8Array)) {
        reply({ ok: false, error: "missing package bytes" });
        break;
      }
      e.waitUntil(
        extensions.installFromZip(em.bytes).then(
          async (r) => {
            /* A live worker never re-runs bootEnabled (activation
               only), so the fresh background boots right here. */
            await bootInstalled(r.id);
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            });
          },
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:installExtFiles": {
      /* UI -> SW: install an unpacked extension (a directory listing
         the UI built from a picked folder). Same manager path. */
      const em = msg as { files?: Array<[string, Uint8Array]> };
      const map = new Map<string, Uint8Array>();
      if (Array.isArray(em.files)) {
        for (const entry of em.files) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] instanceof Uint8Array) {
            map.set(entry[0], entry[1]);
          }
        }
      }
      if (map.size === 0) {
        reply({ ok: false, error: "no usable files" });
        break;
      }
      e.waitUntil(
        extensions.installFiles(map).then(
          async (r) => {
            /* Same as zl:installExt: boot the fresh background now. */
            await bootInstalled(r.id);
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            });
          },
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:extEnable": {
      /* UI -> SW: enable/disable an installed extension. State
         persists in the manager's IndexedDB store. */
      if (!msg.extId || typeof msg.enabled !== "boolean") {
        reply({ ok: false, error: "bad zl:extEnable" });
        break;
      }
      e.waitUntil(
        extensions.setEnabled(msg.extId, msg.enabled).then(
          () => reply({ ok: true }),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:extInfo": {
      /* UI -> SW: one extension's detail card. The panel already has
         the summary from zl:listExt; this adds the manifest surface
         the customize/options affordances need. */
      const rec = msg.extId ? extensions.get(msg.extId) : null;
      if (!rec) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const manifest = rec.manifest as Record<string, unknown>;
      reply({
        ok: true,
        extension: {
          id: rec.id,
          name: rec.name,
          version: rec.version,
          description: typeof manifest.description === "string" ? manifest.description : "",
          state: rec.state,
          enabled: rec.enabled,
          lastError: rec.lastError,
          permissions: rec.permissions,
          hostPermissions: rec.hostPermissions,
          contentScripts: rec.contentScripts.length,
          optionsPath: rec.options ? rec.options.page : null,
        },
      });
      break;
    }
    case "zl:menuClick": {
      /* UI -> SW: a context-menu item was clicked on a proxied page.
         The tab is resolved through the tabs bridge so the extension
         gets a real permission-gated Tab object. */
      const em = msg as { extId?: string; msg?: unknown };
      const info = em.msg as { menuItemId?: unknown; pageUrl?: unknown } | undefined;
      if (
        !em.extId ||
        !info ||
        typeof info.menuItemId !== "string" ||
        typeof info.pageUrl !== "string"
      ) {
        reply({ ok: false, error: "bad menuClick" });
        break;
      }
      const rec = extensions.get(em.extId);
      if (!rec || !rec.enabled) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const tab = TABS.list().find((t) => t.url === info.pageUrl) ?? null;
      /* Menu clicks wake an idle MV3 service-worker background; the
         click delivery itself must outlive this message handler. */
      e.waitUntil(
        wakeExtension(rec.id).then(() => {
          MENUS.click(
            rec.id,
            { menuItemId: String(info.menuItemId), pageUrl: String(info.pageUrl) },
            tab ? tabView(rec, tab) : null,
          );
        }),
      );
      reply({ ok: true });
      break;
    }
    case "zl:listMenus": {
      /* #45: the host lists registered context-menu items so it can
         render a real menu surface. Enabled extensions only; an
         explicit extId must resolve to an enabled extension. */
      const rec = msg.extId ? extensions.get(msg.extId) : null;
      if (msg.extId && (!rec || !rec.enabled)) {
        reply({ ok: false, error: "no such enabled extension" });
        break;
      }
      const recs = rec ? [rec] : extensions.list().filter((r) => r.enabled);
      reply({ ok: true, menus: recs.flatMap((r) => MENUS.itemsFor(r.id)) });
      break;
    }
    case "zl:notifyEvent": {
      /* #43: the host reports a rendered notification's interaction
         back (clicked / closed / buttonClicked). The entry must
         exist and belong to the named enabled extension; delivery
         wakes an idle MV3 background first, same as menu clicks. */
      const ne = msg as { extId?: string; msg?: unknown };
      const info = ne.msg as { id?: unknown; event?: unknown; buttonIndex?: unknown } | undefined;
      const extId = typeof ne.extId === "string" ? ne.extId : "";
      const nid = typeof info?.id === "string" ? info.id : "";
      const kind: "clicked" | "closed" | "buttonClicked" | null =
        info?.event === "clicked" || info?.event === "closed" || info?.event === "buttonClicked"
          ? (info.event as "clicked" | "closed" | "buttonClicked")
          : null;
      const btn = typeof info?.buttonIndex === "number" ? info.buttonIndex : undefined;
      if (!extId || !nid || !kind || (kind === "buttonClicked" && btn === undefined)) {
        reply({ ok: false, error: "bad notifyEvent" });
        break;
      }
      const erec = extensions.get(extId);
      if (!erec || !erec.enabled || !NOTIFY.exists(extId, nid)) {
        reply({ ok: false, error: "no such notification" });
        break;
      }
      e.waitUntil(wakeExtension(extId).then(() => NOTIFY.event(extId, nid, kind, btn)));
      reply({ ok: true });
      break;
    }
    case "zl:extPage": {
      /* #40: RPC from an extension-origin page (options/popup). The
         sender must be a client registered as that extension's page:
         client ids are SW-observed on the granted navigation, so a
         hostile proxied page cannot forge one. The API subset is
         enforced in handleExtPageCall. */
      const ep = msg as { extId?: unknown; msg?: unknown };
      const src = e.source as Client | null;
      const extId = typeof ep.extId === "string" ? ep.extId : "";
      const srcId = src && src.url ? src.id : "";
      const srcUrl = src && src.url ? src.url : null;
      if (!extId || !srcId || pageClientOf(srcId) !== extId) {
        reply({ ok: false, error: "not an extension page" });
        break;
      }
      const erec = extensions.get(extId);
      if (!erec || !erec.enabled) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const call = (ep.msg ?? {}) as { path?: unknown; args?: unknown };
      const path = Array.isArray(call.path) ? call.path : [];
      /* runtime.sendMessage needs the background booted to have
         listeners; other page calls answer from the shared context. */
      const wake =
        path[0] === "runtime" && path[1] === "sendMessage"
          ? wakeExtension(extId)
          : Promise.resolve();
      e.waitUntil(
        wake
          .then(() => handleExtPageCall(erec, srcUrl, call))
          .then(reply)
          .catch((err: unknown) => reply({ ok: false, error: String(err) })),
      );
      break;
    }
    case "zl:openExtPage": {
      /* #40: host-only. Resolves an extension's options or popup
         page, mints a 5-minute page token and answers the /zl-ext/
         URL the host should navigate a tab to. The token is the only
         way a first navigation gets past the WAR gate for a non-WAR
         page. */
      const op = msg as { extId?: unknown; which?: unknown };
      const which = op.which === "popup" ? "popup" : "options";
      const extId = typeof op.extId === "string" ? op.extId : "";
      const orec = extId ? extensions.get(extId) : null;
      const raw = which === "popup" ? orec?.action?.defaultPopup : orec?.options?.page;
      const norm = raw ? normalizeExtensionPath(raw.startsWith("/") ? raw : "/" + raw) : null;
      if (!orec || !orec.enabled || !norm) {
        reply({ ok: false, error: "no such " + which + " page" });
        break;
      }
      reply({ ok: true, url: EXT_ROUTE + orec.id + norm + "?zlPageTok=" + mintPageToken(orec.id, norm) });
      break;
    }
    default:
      reply({ ok: false, error: "unknown message" });
  }
}

/** Extension messages from content-script bridges. Deliver to the
    extension's background listeners or storage areas after verifying
    the sender page actually matches the extension's declared
    content_scripts. */
async function handleExtMessage(
  ev: ExtendableMessageEvent,
  m: { extId: string; msg: unknown },
): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  const src = ev.source as Client | null;
  if (!src || !src.url) return { ok: false, error: "unknown sender" };
  const su = new URL(src.url, self.location.origin);
  const dest = decodePath(su.pathname) + su.search;
  if (!dest) return { ok: false, error: "unknown sender page" };
  const rec = extensions.get(m.extId);
  if (!rec || !rec.enabled) return { ok: false, error: "no such extension" };
  const matched = rec.contentScripts.some(
    (s) => contentScriptMatches(s, dest, false) || contentScriptMatches(s, dest, true),
  );
  if (!matched) {
    return { ok: false, error: "extension content scripts do not match this page" };
  }
  const msg = m.msg as Record<string, unknown> | null;
  if (msg && typeof msg === "object" && typeof msg.__zlTabReply === "string") {
    /* Content-script reply to a tabs.sendMessage: route it back to
       the pending promise (unknown nonces are ignored). */
    TABS.resolveTabMessage(String(msg.__zlTabReply), msg.response);
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlTabError === "string") {
    TABS.rejectTabMessage(
      String(msg.__zlTabError),
      String(msg.error ?? "zeolite: content-script message failed"),
    );
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlDomLoaded === "string") {
    /* Page-world bridge reports DOM readiness: the only honest
       onDOMContentLoaded source (see ./bridge). */
    WEBNAV.domContentLoaded(String(msg.__zlDomLoaded));
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlStorage === "string") {
    if (!rec.permissions.includes("storage")) {
      return { ok: false, error: "storage permission not granted" };
    }
    const ctx = await getExtensionContext(rec);
    const area = (ctx.storage as unknown as Record<string, ExtensionStorageArea>)[
      String(msg.__zlStorage)
    ];
    if (!area) return { ok: false, error: "no such storage area" };
    const op = String(msg.op ?? "");
    let r: Promise<unknown>;
    if (op === "get") r = area.get(msg.keys as string | string[] | null);
    else if (op === "set") r = area.set(msg.items as Record<string, unknown>);
    else if (op === "remove") r = area.remove(msg.keys as string | string[]);
    else if (op === "clear") r = area.clear();
    else return { ok: false, error: "bad storage op" };
    return { ok: true, response: await r };
  }
  /* Wake an idle-terminated MV3 service-worker background so it can
     receive this message (persistent backgrounds are already live,
     and a crashed worker is never restarted). */
  await wakeExtension(rec.id);
  const response = await MESSENGER.sendMessage(rec.id, {
    extensionId: rec.id,
    context: "content",
    url: dest,
  }, m.msg);
  return { ok: true, response };
}



// Registry of extension-facing zl: message types (#90): exactly the
// labels the switch in dispatchExtControl below handles. control.test.ts
// pins it against that switch.
export const EXT_CONTROL_TYPES: ReadonlySet<string> = new Set([
  "zl:ext", "zl:tabs", "zl:listExt", "zl:installExt", "zl:installExtFiles", "zl:extEnable", "zl:extInfo", "zl:menuClick", "zl:listMenus", "zl:notifyEvent", "zl:extPage", "zl:openExtPage", "zl:downloadState",
]);

