import { describe, expect, it } from "vitest";
import { applyCookieStore } from "../bootstrap/cookiestore";

/* #534: the cookieStore facade over the real MessageChannel it
   creates; the fake controller only captures the transferred port,
   and the test answers ops and pushes jar views exactly like the
   control-plane docCookie handler does. */

type PortLike = {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(d: unknown): void;
};

function install(): { store: Record<string, unknown>; jarPort: PortLike | null } {
  const captured: { port: PortLike | null } = { port: null };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        controller: {
          postMessage: (_msg: unknown, transfer?: unknown[]) => {
            if (transfer && transfer.length) captured.port = transfer[0] as PortLike;
          },
        },
      },
    },
    configurable: true,
    writable: true,
  });
  const store = applyCookieStore("site-token", {} as Record<string, unknown>);
  return { store: store ?? {}, jarPort: captured.port };
}

const settle = () => new Promise<void>((res) => setTimeout(res, 0));

/* CI timing, same race as bootstrap-cookie.test.ts (run 41224320035):
   poll bounded ticks for jar pushes instead of one setTimeout(0) tick. */
async function ticks(until?: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max && !(until && until()); i++) await settle();
}

describe("cookieStore facade (#534)", () => {
  it("returns null without a controller or site token", () => {
    Object.defineProperty(globalThis, "navigator", { value: { serviceWorker: {} }, configurable: true, writable: true });
    expect(applyCookieStore("", {} as Record<string, unknown>)).toBeNull();
    expect(applyCookieStore("site", {} as Record<string, unknown>)).toBeNull();
  });

  it("getAll resolves the records from the jar reply", async () => {
    const { store, jarPort } = install();
    const ops: Array<{ data: { cs?: { op?: string; rid?: number }; rid?: number } }> = [];
    jarPort!.onmessage = (ev) => {
      const d = ev.data as { cs?: { op?: string; rid?: number }; rid?: number };
      if (d.cs && typeof d.cs.rid !== "number") throw new Error("op rid must ride inside cs");
      ops.push({ data: d });
      jarPort!.postMessage({
        ok: true,
        cookie: "a=1; b=2",
        items: [
          { name: "a", value: "1", path: "/", secure: false, sameSite: null, expires: 0 },
          { name: "b", value: "2", path: "/", secure: false, sameSite: null, expires: 0 },
        ],
        rid: d.cs?.rid,
      });
    };
    const items = (await (store.getAll as () => Promise<unknown[]>)()) as Array<{ name: string }>;
    expect(items.map((i) => i.name)).toEqual(["a", "b"]);
    expect(ops[0].data.cs?.op).toBe("getAll");
  });

  it("get(name) filters to the matching record", async () => {
    const { store, jarPort } = install();
    jarPort!.onmessage = (ev) => {
      const d = ev.data as { cs?: { rid?: number }; rid?: number };
      jarPort!.postMessage({
        ok: true,
        cookie: "a=1",
        items: [{ name: "a", value: "1", path: "/", secure: false, sameSite: null, expires: 0 }],
        rid: d.cs?.rid,
      });
    };
    const got = (await (store.get as (n: string) => Promise<unknown>)("a")) as { name: string } | null;
    expect(got?.name).toBe("a");
    expect(await (store.get as (n: string) => Promise<unknown>)("zz")).toBeNull();
  });

  it("set and delete send ops and resolve after the reply", async () => {
    const { store, jarPort } = install();
    const sent: Array<{ cs?: { op?: string; init?: Record<string, unknown> } }> = [];
    jarPort!.onmessage = (ev) => {
      const d = ev.data as { cs?: { op?: string; init?: Record<string, unknown>; rid?: number }; rid?: number };
      sent.push({ cs: d.cs });
      jarPort!.postMessage({ ok: true, cookie: "", items: [], rid: d.cs?.rid });
    };
    await (store.set as (a: unknown, b?: unknown) => Promise<void>)("n", "v");
    expect(sent[0].cs?.op).toBe("set");
    expect(sent[0].cs?.init).toEqual({ name: "n", value: "v" });
    await (store.delete as (a: unknown) => Promise<void>)({ name: "n", path: "/" });
    expect(sent[1].cs?.op).toBe("delete");
    expect(sent[1].cs?.init).toEqual({ name: "n", path: "/" });
  });

  it("onchange fires a diff on jar pushes and removeEventListener clears it", async () => {
    const { store, jarPort } = install();
    jarPort!.onmessage = null;
    const events: unknown[] = [];
    const handler = (ev: unknown): void => {
      events.push(ev);
    };
    (store.onchange as unknown) = null;
    (store.addEventListener as (t: string, h: (ev: unknown) => void) => void)("change", handler);
    jarPort!.postMessage({ ok: true, cookie: "a=1; b=2" });
    await ticks(() => events.length === 1);
    jarPort!.postMessage({ ok: true, cookie: "a=1; c=3" });
    await ticks(() => events.length === 2);
    expect(events).toEqual([
      { type: "change", changed: [{ name: "a", value: "1" }, { name: "b", value: "2" }], deleted: [] },
      { type: "change", changed: [{ name: "c", value: "3" }], deleted: [{ name: "b", value: "2" }] },
    ]);
    (store.removeEventListener as (t: string, h: (ev: unknown) => void) => void)("change", handler);
    jarPort!.postMessage({ ok: true, cookie: "a=1" });
    await ticks(undefined, 50);
    expect(events.length).toBe(2);
  });
});
