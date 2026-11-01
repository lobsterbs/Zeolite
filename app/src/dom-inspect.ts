/* Tier 2 DOM inspection bridge, engine half (#550 first slice).

   The devtools page (a host page) authorizes an inspection session for
   one live proxied client; the SW relays snapshot / computed-styles /
   console requests to that page's bootstrap bridge over the standard
   SW->client message path (the same one zl:scripting and zl:findLoad
   use) and answers the devtools caller with the bridge's serialized
   reply. The SW never touches page DOM; the bridge never sends DOM
   objects (plain data only).

   Authorization: default OFF. A session exists only after
   zl:domInspect {op:"authorize"} from a host-page sender names a live
   proxied client AND the client's bridge answers the authorize
   handshake. The bridge itself is not part of the bootstrap: the
   authorize message carries the compiled dominspect.js source (the
   finder.js shipping pattern), the page's loader evaluates it once,
   and the handshake reply pins the generation. Teardown: explicit revoke, navigation (a new document
   realm starts unauthorized and its generation differs), client
   death (the next request fails the live check) and worker restart
   (memory-only state).

   Generation stamp (netlog's stampNetGeneration pattern, page-side):
   the bridge stamps one per document realm; the session pins the
   generation seen at authorize, and any reply whose generation
   differs is stale - discarded, never forwarded.

   Redaction: every string the bridge returns passes redactSecrets
   here before it reaches the devtools page (the bridge applies a
   compact mirror of the same patterns; this side is authoritative).

   Not in this slice: element highlighting, storage view, a
   "strict" privacy mode that would disable devtools entirely
   (documented as future work in docs/power-features.md). */

import { redactSecrets } from "./diag";
import { senderIsProxiedPath } from "./cpgate";

declare const self: ServiceWorkerGlobalScope;

export interface DomInspectSession {
  clientId: string;
  /** Page generation pinned at authorize (bridge eval epoch). */
  gen: number;
  ts: number;
}

/* Bounded: a handful of concurrently inspected documents; the oldest
   session silently expires past the cap (authorize again to renew). */
const SESSION_CAP = 8;
const sessions = new Map<string, DomInspectSession>();

/** Console reply cap: the bridge already bounds its ring; the engine
    refuses to forward anything larger (defense in depth). */
const CONSOLE_ENTRIES_CAP = 128;
/** Longest string forwarded per reply field. */
const FIELD_CAP = 2000;

/* The compiled page-side bridge ships on demand (the finder.js
   pattern, #29): fetched once per SW instance - worker-own fetches
   never re-enter this fetch handler - and attached to the authorize
   ctl message, because the loader evaluates code only when a message
   carries it. An unavailable bundle answers authorize honestly
   instead of pretending the bridge exists. */
let inspectorSource: Promise<string | null> | null = null;
function loadInspectorSource(): Promise<string | null> {
  inspectorSource ??= fetch(new URL("dominspect.js", self.location.href))
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  return inspectorSource;
}

export function domInspectSession(clientId: string): DomInspectSession | null {
  return sessions.get(clientId) ?? null;
}

/** A live client whose URL is a proxied page on this origin, or null.
    Host pages (devtools, adapter) are NOT inspectable targets - and
    they are the senders, never the targets. */
async function liveProxiedClient(clientId: string): Promise<Client | null> {
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 256) return null;
  let client: Client | undefined;
  try {
    client = await self.clients.get(clientId);
  } catch {
    return null;
  }
  if (!client || !client.url) return null;
  try {
    const u = new URL(client.url);
    if (u.origin !== self.location.origin || !senderIsProxiedPath(u.pathname, u.search)) return null;
  } catch {
    return null;
  }
  return client;
}

function relayOnce(
  client: Client,
  payload: Record<string, unknown>,
  timeoutMs: number,
  transfer: Transferable[] = [],
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const mc = new MessageChannel();
    let done = false;
    const finish = (v: Record<string, unknown> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mc.port1.onmessage = null;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    mc.port1.onmessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null | undefined;
      finish(d && typeof d === "object" ? d : null);
    };
    try {
      client.postMessage({ type: payload.ctl ? "zl:domInspectCtl" : "zl:domInspectReq", ...payload }, [
        mc.port2,
        ...transfer,
      ]);
    } catch {
      finish(null);
    }
  });
}

/** Authorize an inspection session: the host already passed the
    host-only gate; the target must be a live proxied client whose
    bridge answers the handshake. Returns the pinned page generation
    on success so the caller (devtools) can discard stale replies. */
export async function domInspectAuthorize(
  clientId: string,
  timeoutMs = 3000,
): Promise<{
  ok: boolean;
  error?: string;
  gen?: number;
}> {
  const client = await liveProxiedClient(clientId);
  if (!client) return { ok: false, error: "no live proxied client for clientId" };
  const code = await loadInspectorSource();
  if (code === null) return { ok: false, error: "inspector bundle unavailable" };
  const handshake = await relayOnce(client, { on: true, ctl: true, code }, timeoutMs);
  if (!handshake || handshake.ok !== true || typeof handshake.gen !== "number") {
    /* The page answered nothing: no bootstrap bridge (old document,
       guest realm, or a page that never loaded the new bundle). */
    return { ok: false, error: "bridge did not answer the authorize handshake" };
  }
  sessions.delete(clientId); /* re-authorize refreshes in place */
  sessions.set(clientId, { clientId, gen: handshake.gen, ts: Date.now() });
  if (sessions.size > SESSION_CAP) {
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
  return { ok: true, gen: handshake.gen };
}

/** Revoke: drop the session and tell the bridge to tear down (console
    patch restored, ring and snapshot cache dropped). */
export function domInspectRevoke(clientId: string): boolean {
  const had = sessions.delete(clientId);
  if (had) {
    void liveProxiedClient(clientId).then((c) => {
      c?.postMessage({ type: "zl:domInspectCtl", on: false });
    });
  }
  return had;
}

/* The authoritative string gate: redact, then cap. Non-string leaves
   pass untouched (the bridge sends primitives only; anything else is
   dropped by the shape checks below). */
function gate(s: string): string {
  return redactSecrets(s).slice(0, FIELD_CAP);
}

function gateDeep(v: unknown, depth: number): unknown {
  if (typeof v === "string") return gate(v);
  if (Array.isArray(v)) {
    if (depth > 6) return null;
    return v.slice(0, 512).map((x) => gateDeep(x, depth + 1));
  }
  if (v && typeof v === "object") {
    if (depth > 6) return null;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 64)) {
      out[k] = gateDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}

function gateReply(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 32)) {
    out[k] = gateDeep(v, 0);
  }
  return out;
}

/** Relay one inspection request to the authorized client. The reply's
    generation must match the session's pinned page generation - a
    mismatch means the document navigated and the reply describes a
    realm nobody authorized. */
export async function domInspectRequest(
  clientId: string,
  op: "snapshot" | "styles" | "console",
  nodeId?: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const session = sessions.get(clientId);
  if (!session) return { ok: false, error: "no inspection session for clientId" };
  const client = await liveProxiedClient(clientId);
  if (!client) {
    sessions.delete(clientId);
    return { ok: false, error: "client is gone (navigation closed it)" };
  }
  const raw = await relayOnce(client, { op, nodeId }, timeoutMs);
  if (!raw || raw.ok !== true) {
    return { ok: false, error: raw && typeof raw.error === "string" ? raw.error : "bridge did not answer" };
  }
  if (raw.gen !== session.gen) {
    /* Stale generation: the inspected document was replaced. The
       session dies here too - authorize again for the new document. */
    sessions.delete(clientId);
    return { ok: false, stale: true, error: "stale document generation; authorize again" };
  }
  if (op === "console" && Array.isArray(raw.entries) && raw.entries.length > CONSOLE_ENTRIES_CAP) {
    return { ok: false, error: "bridge console reply over cap" };
  }
  return gateReply(raw);
}

/** Tests only: drop every session and the cached bundle source. */
export function domInspectResetForTests(): void {
  sessions.clear();
  inspectorSource = null;
}
