/* Control plane for signed modules (#542): host-driven install,
   revoke and list. The verbs ride the same host-only gate as the
   extension verbs (a proxied page can never reach them), the
   registry owns every validation, and every rejection is a bounded
   structured reply, never a failed message. */

import * as REG from "./registry";

export const MODULE_CONTROL_TYPES: ReadonlySet<string> = new Set([
  "zl:modulesInstall",
  "zl:modulesRevoke",
  "zl:modulesList",
]);

interface Ctx {
  e: ExtendableMessageEvent;
  reply: (r: unknown) => void;
}

interface ModuleControlMessage {
  type?: string;
  module?: { manifest?: unknown; sig?: string; granted?: string[] };
  moduleId?: string;
  keyId?: string;
}

export async function dispatchModuleControl(msg: unknown, opts: Ctx): Promise<void> {
  const m = (msg ?? {}) as ModuleControlMessage;
  switch (m.type) {
    case "zl:modulesInstall": {
      /* UI -> SW: install a signed module record. The registry owns
         validation; a bad record is a structured rejection, never a
         failed message or retained state. */
      if (!m.module || typeof m.module !== "object") {
        opts.reply({ ok: false, error: "missing module record" });
        break;
      }
      opts.e.waitUntil(
        REG.install({ manifest: m.module.manifest, sig: m.module.sig, granted: m.module.granted }).then(
          (r) =>
            opts.reply(
              r.ok
                ? { ok: true, id: r.record.id, version: r.record.version, granted: r.record.granted, updated: r.updated }
                : { ok: false, reason: r.reason },
            ),
          (err) => opts.reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:modulesRevoke": {
      /* UI -> SW: revoke one module by id, or a whole signer key
         (quarantining every module it signed). */
      if (typeof m.moduleId === "string" && m.moduleId.length > 0) {
        opts.e.waitUntil(
          REG.revoke(m.moduleId).then(
            (r) => opts.reply(r.ok ? { ok: true, revoked: "module" } : { ok: false, reason: r.reason }),
            (err) => opts.reply({ ok: false, error: String(err) }),
          ),
        );
      } else if (typeof m.keyId === "string" && m.keyId.length > 0) {
        opts.e.waitUntil(
          REG.revokeKey(m.keyId).then(
            (r) => opts.reply({ ok: true, revoked: "key", quarantined: r.count }),
            (err) => opts.reply({ ok: false, error: String(err) }),
          ),
        );
      } else {
        opts.reply({ ok: false, error: "bad zl:modulesRevoke" });
      }
      break;
    }
    case "zl:modulesList": {
      /* UI -> SW: display surface. Summaries only: no signatures, no
         canonical bytes, no file hashes. */
      opts.e.waitUntil(
        REG.list().then(
          (modules) => opts.reply({ ok: true, modules }),
          (err) => opts.reply({ ok: false, error: String(err) }),
        ),
      );
      break;
      }
  }
}
