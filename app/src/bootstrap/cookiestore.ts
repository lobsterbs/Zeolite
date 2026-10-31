/* cookieStore facade (#534): a per-virtual-site asynchronous
   cookie API riding the same zl:docCookie control channel as the
   document.cookie shim. Never the native engine-origin CookieStore:
   the jar origin is recovered SW-side from the sender's own client
   route (a page claim is never read), the records never carry the
   upstream Domain string (the page host is opaque) and HttpOnly
   cookies are never exposed.

   Semantics: get/getAll/set/delete are promise-based (the facade
   resolves an op only after the authoritative jar answered);
   onchange and the change event fire on jar pushes (Set-Cookie on a
   proxied response reaches this port through the same #35 push the
   document.cookie copy rides), diffed name=value pairs producing
   changed[] and deleted[] records. A page-supplied Domain is ignored
   (host-only admission); expiry, Secure and SameSite keep their real
   semantics through the script-write admission seam. */

import { swc } from "./siteid";

export interface FacadeRecord {
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  sameSite?: string;
  /** Epoch ms, 0 for a session cookie. */
  expires?: number;
}

interface ChangeEv {
  type: "change";
  changed: Array<{ name: string; value: string }>;
  deleted: Array<{ name: string; value: string }>;
}

type ChangeHandler = (ev: ChangeEv) => void;

/** Install and return the facade, or null when no controller or site
    token exists (the caller keeps the window native then). The
    caller owns the defineProperty install (isolation.ts), same as
    every other virtual surface. */
export function applyCookieStore(
  site: string,
  _w: Record<string, unknown>,
): Record<string, unknown> | null {
  const ctl = swc();
  if (!ctl || !site) return null;
  let cur = "";
  let seq = 0;
  let onchg: ChangeHandler | null = null;
  const waiting = new Map<number, (r: { items?: FacadeRecord[] }) => void>();
  const ch = new MessageChannel();
  ctl.postMessage({ type: 'zl:docCookie' }, [ch.port2]);
  const fire = (next: string): void => {
    const prev = cur;
    cur = next;
    if (onchg === null || prev === next) return;
    const of_ = (s: string): Array<[string, string]> =>
      s ? (s.split("; ") as string[]).map((p) => [p.slice(0, p.indexOf("=")), p] as [string, string]) : [];
    const a = of_(prev);
    const b = of_(next);
    const changed: Array<{ name: string; value: string }> = [];
    const deleted: Array<{ name: string; value: string }> = [];
    for (const [n, p] of b) {
      const old = a.find((e) => e[0] === n);
      if (!old || old[1] !== p) changed.push({ name: n, value: p.slice(n.length + 1) });
    }
    for (const [n, p] of a) {
      if (!b.some((e) => e[0] === n)) deleted.push({ name: n, value: p.slice(n.length + 1) });
    }
    if (changed.length || deleted.length) onchg({ type: "change", changed, deleted });
  };
  ch.port1.onmessage = (ev) => {
    const d = ev.data as { cookie?: string; items?: FacadeRecord[]; rid?: number };
    if (typeof d.cookie === "string") fire(d.cookie);
    if (typeof d.rid === "number") {
      const res = waiting.get(d.rid);
      if (res) {
        waiting.delete(d.rid);
        res(d);
      }
    }
  };
  /* The SW-side docCookie handler expects the op rid INSIDE the cs
     payload ({ cs: { op, init, rid } }) and echoes it in the reply
     envelope; a rid on the outer message would never be answered. */
  const send = (cs: Record<string, unknown>): Promise<{ items?: FacadeRecord[] }> =>
    new Promise((res) => {
      const rid = ++seq;
      waiting.set(rid, res);
      ch.port1.postMessage({ cs: { ...cs, rid } });
    });
  const norm = (i: FacadeRecord): FacadeRecord => ({
    name: i.name,
    value: i.value,
    path: i.path,
    secure: i.secure,
    sameSite: i.sameSite,
    expires: i.expires,
  });
  return {
    async get(name: unknown): Promise<FacadeRecord | null> {
      const items = (await send({ op: "getAll" })).items ?? [];
      const n = typeof name === "string" ? name : String((name as { name?: unknown } | null)?.name ?? "");
      return items.find((i) => i.name === n) ?? null;
    },
    async getAll(): Promise<FacadeRecord[]> {
      return ((await send({ op: "getAll" })).items ?? []).map(norm);
    },
    async set(a: unknown, b?: unknown): Promise<void> {
      const init =
        typeof a === "string"
          ? b === undefined
            ? { name: a }
            : { name: a, value: String(b) }
          : ((a as Record<string, unknown>) ?? {});
      await send({ op: "set", init });
    },
    async delete(a: unknown): Promise<void> {
      const init = typeof a === "string" ? { name: a } : ((a as Record<string, unknown>) ?? {});
      await send({ op: "delete", init });
    },
    get onchange(): ChangeHandler | null {
      return onchg;
    },
    set onchange(h: ChangeHandler | null) {
      onchg = typeof h === "function" ? h : null;
    },
    addEventListener(t: string, h: ChangeHandler): void {
      if (t === "change" && typeof h === "function") onchg = h;
    },
    removeEventListener(_t: string, h: ChangeHandler): void {
      if (onchg === h) onchg = null;
    },
  };
}
