import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  { mode: "no-cache", status: 304, credentials: "include", admitted: true },
  { mode: "no-cache", status: 200, credentials: "include", admitted: true },
  { mode: "stale", status: 200, credentials: "include", admitted: true },
  { mode: "no-cache", status: 304, credentials: "omit", admitted: false },
  { mode: "no-cache", status: 304, credentials: "same-origin", admitted: false },
] as const)("uses policy and cookie context for $mode/$status/$credentials refresh (#466/#467)", async ({ mode, status, credentials, admitted }) => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('rule "relay" { route "relay" }')));
  vi.stubGlobal("self", { location: { origin: "https://engine.example" } });
  vi.stubGlobal("caches", { open: async (name: string) => ({
    match: async () => name === "zeolite-jar-profile-v1" ? undefined : new Response("stored", { headers: {
      "cache-control": mode === "no-cache" ? "no-cache" : "max-age=1", etag: '"v1"',
      "x-zl-cached-at": String(Date.now() - 60000),
    } }),
    put: async () => {}, keys: async () => [], delete: async () => true,
  }) });
  const { pageCacheMatch } = await import("../request");
  const { relayRegister } = await import("../relayfetch");
  const { wispTransport } = await import("../transport");
  const c = await import("../cookies");
  c.setJarProfile("private", "host");
  c.inheritJarClient("host", "frame");
  const wire = vi.spyOn(wispTransport, "fetch");
  const seen: Array<{ rid: number; dest: string; headers: Array<[string, string]> }> = [];
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(m: { type: string; rid: number; dest: string; headers: Array<[string, string]> }) {
      if (m.type !== "zl:fetchRelay") return;
      seen.push(m);
      const first = seen.length === 1;
      queueMicrotask(() => {
        port.onmessage?.(new MessageEvent("message", { data: {
          type: "zl:relayHead", rid: m.rid, status: first ? 302 : status, statusText: "",
          headers: first ? [["location", "https://next.example/item"]] : [["content-type", "text/plain"]],
          setCookies: [first ? "start=1; Path=/" : "end=2; Path=/"],
        } }));
        if (!first && status === 200) port.onmessage?.(new MessageEvent("message", { data: { type: "zl:relayChunk", rid: m.rid, bytes: new TextEncoder().encode("fresh") } }));
        port.onmessage?.(new MessageEvent("message", { data: { type: "zl:relayEnd", rid: m.rid } }));
      });
    },
  };
  relayRegister(port as unknown as MessagePort);
  const kept: Promise<unknown>[] = [];
  const out = await pageCacheMatch(new Request("https://first.example/item", { credentials }), p => { kept.push(p); }, { clientId: "frame", initiator: "https://initiator.example/" });
  await Promise.all(kept);
  if (mode === "stale" || status === 304) expect(await out?.text()).toBe("stored");
  expect(wire).not.toHaveBeenCalled();
  expect(seen).toHaveLength(2);
  expect(seen.map(s => s.dest)).toEqual(["https://first.example/item", "https://next.example/item"]);
  expect(new Headers(seen[0].headers).get("if-none-match")).toBe('"v1"');
  expect(new Headers(seen[1].headers).get("if-none-match")).toBeNull();
  expect(c.cookieHeaderFor("https://first.example/", { clientId: "frame" })).toBe(admitted ? "start=1" : null);
  expect(c.cookieHeaderFor("https://next.example/", { clientId: "frame" })).toBe(admitted ? "end=2" : null);
  expect(c.cookieHeaderFor("https://next.example/")).toBeNull();
  c.cookiesResetForTests();
});
