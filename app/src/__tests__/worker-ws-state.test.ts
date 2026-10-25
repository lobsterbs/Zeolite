import { afterAll, describe, expect, it } from "vitest";
import { encodeDest, setScheme } from "../codec";
import { installWorkerPrelude } from "../worker-prelude";

const g = globalThis as unknown as Record<string, unknown>;
const saved = {
  WebSocket: g.WebSocket,
  postMessage: g.postMessage,
  location: g.location,
  prefix: g.__ZL_PREFIX__,
  fetch: g.fetch,
};

afterAll(() => {
  for (const [key, value] of Object.entries({
    WebSocket: saved.WebSocket, postMessage: saved.postMessage,
    location: saved.location, __ZL_PREFIX__: saved.prefix, fetch: saved.fetch,
  })) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

describe("worker WebSocket shim states (#460/#461)", () => {
  it("throws on connecting send and invalid close, then discards after close", async () => {
    if (!saved.WebSocket) return;
    let port: MessagePort | undefined;
    g.__ZL_PREFIX__ = "/j/";
    g.location = { href: "https://engine.example/j/worker", origin: "https://engine.example" };
    g.postMessage = (_m: unknown, transfer: Transferable[]) => { port = transfer[0] as MessagePort; };
    setScheme("/j/");
    installWorkerPrelude(encodeDest("https://site.example/worker.js"));
    const WS = g.WebSocket as new (url: string) => WebSocket;
    const ws = new WS("wss://site.example/socket");
    expect(() => ws.send("early")).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
    expect(() => ws.close(1001)).toThrowError(expect.objectContaining({ name: "InvalidAccessError" }));
    expect(() => ws.close(1000, "é".repeat(62))).toThrowError(expect.objectContaining({ name: "SyntaxError" }));
    expect(ws.readyState).toBe(0);
    port!.postMessage({ ev: "open" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.readyState).toBe(1);
    ws.send("open");
    ws.close(4999, "ok");
    expect(ws.readyState).toBe(2);
    expect(() => ws.send("late")).not.toThrow();
  });
});
