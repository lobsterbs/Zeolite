/* Boot binding seam (#542): which compiled-in plugin names belong to
   signed modules, and how an installed, granted record promotes them.
   The service worker cannot late-load code, so the code identity is a
   static import (the build registry); what the module system adds is
   attribution, permission gating, revocation and install state. A
   claimed name that is not installed+granted+verified fails closed
   (null) and never falls back to the static registry: an unverified
   compiled-in module must not run just because it exists in the
   bundle. Unclaimed names keep the legacy static path unchanged. */

import { DIAG } from "../diag";
import { ZEOLITE_VERSION } from "../swstate";
import type { PluginHooks, RequestCtx, ResponseCtx } from "../plugins";
import { REGISTRY } from "../plugins/registry";
import { installedRecords, type ModuleRecord } from "./registry";
import { engineAccepts } from "./schema";
import { SIGNER_KEYS, verifyWithKeys } from "./verify";

/* siteconfig plugin name -> module id. The sample observer is the
   first signed bundle (docs/plugin-modules-design.md step 2). */
export const MODULE_IDENTITIES: Record<string, string> = {
  "sample-observer": "im.zeolite.sample-observer",
};

const bound = new Map<string, PluginHooks>();
const warned = new Set<string>();

function warnOnce(kind: string, detail: string, category: "UNSUPPORTED" | "RUNTIME"): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  DIAG.emit({ category, cause: kind === "module-hook-failed" ? "failure" : "unsupported", severity: "warning", message: detail });
}

function engineVersionTriple(): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(ZEOLITE_VERSION);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** The capability-wrapped hook set for a bound module: contexts arrive
    frozen, hook throws are isolated, and onRequest return values are
    honored only under an explicit modify:requests grant. */
function wrapHooks(record: ModuleRecord, inner: PluginHooks): PluginHooks {
  const hooks: PluginHooks = {};
  const granted = new Set(record.granted);
  const canObserve = granted.has("observe:requests");
  const canModify = granted.has("modify:requests");
  if (!canObserve) return {};
  if (inner.onRequest) {
    hooks.onRequest = (ctx: RequestCtx) => {
      if (!canObserve) return;
      const frozen: RequestCtx = Object.freeze({
        url: ctx.url,
        headers: Object.freeze({ ...ctx.headers }),
      });
      try {
        const out = inner.onRequest!(frozen);
        /* Header edits are a separate capability: without
           modify:requests the return value is dropped, not an error. */
        return canModify ? out : undefined;
      } catch {
        warnOnce("module-hook-failed:" + record.id, "module hook failed: " + record.id, "RUNTIME");
        return undefined;
      }
    };
  }
  if (inner.onResponse) {
    hooks.onResponse = (ctx: ResponseCtx) => {
      if (!canObserve) return;
      const frozen: ResponseCtx = Object.freeze({
        url: ctx.url,
        status: ctx.status,
        headers: Object.freeze({ ...ctx.headers }),
      });
      try {
        inner.onResponse!(frozen);
      } catch {
        warnOnce("module-hook-failed:" + record.id, "module hook failed: " + record.id, "RUNTIME");
      }
    };
  }
  return hooks;
}

/** Boot pass (sw.ts initReady): re-verify every installed record
    against the stored canonical bytes (storage tamper defense) and
    bind the verified, granted modules. Per-record failures are ONE
    bounded diagnostic each; the boot itself never fails. */
export async function bindInstalledModules(): Promise<void> {
  const records = await installedRecords();
  for (const record of records) {
    const name = Object.keys(MODULE_IDENTITIES).find((n) => MODULE_IDENTITIES[n] === record.id);
    if (!name) {
      warnOnce("no-binding:" + record.id, "installed module has no binding in this build: " + record.id, "UNSUPPORTED");
      continue;
    }
    const register = REGISTRY[name];
    if (!register) {
      warnOnce("no-register:" + record.id, "module binding has no registry code: " + name, "UNSUPPORTED");
      continue;
    }
    const keyOk = await verifyWithKeys(SIGNER_KEYS, record.canonical, record.sigHex);
    if (keyOk !== record.keyId) {
      warnOnce("bad-signature:" + record.id, "installed module failed signature re-verification: " + record.id, "UNSUPPORTED");
      continue;
    }
    if (!engineAccepts(record.engine, engineVersionTriple())) {
      warnOnce("engine-range:" + record.id, "installed module no longer fits the engine range: " + record.id, "UNSUPPORTED");
      continue;
    }
    const inner: PluginHooks = {};
    try {
      register(inner);
    } catch {
      warnOnce("register-failed:" + record.id, "module failed to register: " + record.id, "RUNTIME");
      continue;
    }
    const hooks = wrapHooks(record, inner);
    if (record.granted.length === 0 || hooks.onRequest === undefined && hooks.onResponse === undefined && (inner.onRequest !== undefined || inner.onResponse !== undefined)) {
      warnOnce("no-observe:" + record.id, "module bound without observe:requests: hooks not registered: " + record.id, "UNSUPPORTED");
      continue;
    }
    bound.set(name, hooks);
    DIAG.emit({
      category: "RUNTIME",
      severity: "info",
      message: "module bound: " + record.id + " " + record.version + " (" + name + ")",
    });
  }
}

/** plugins.ts seam: undefined = name is not module-claimed (legacy
    path unchanged); an object = the verified, granted hook set; null
    = claimed but not installable right now (fail closed, ONE bounded
    diagnostic per name per boot). */
export function boundModuleHooks(name: string): PluginHooks | null | undefined {
  if (!(name in MODULE_IDENTITIES)) return undefined;
  if (bound.has(name)) return bound.get(name);
  const id = MODULE_IDENTITIES[name];
  warnOnce("not-installed:" + name, "signed module is not installed: " + id + " (" + name + ")", "UNSUPPORTED");
  return null;
}
