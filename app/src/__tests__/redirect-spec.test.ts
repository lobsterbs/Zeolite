import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Fetch spec redirect step through the REAL handleFetch hop loop:
   only 301/302/303/307/308 are redirect statuses, and a 303 rewrites
   the method to GET only when it is not already GET or HEAD. */

const transportMock = vi.hoisted(() => ({
  urls: [] as string[],
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      transportMock.urls.push(url);
      transportMock.inits.push(init ? { method: init.method, headers: new Headers(init.headers), body: init.body } : undefined);
      return transportMock.queue.shift() ?? new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";
import { cookiesResetForTests } from "../cookies";

const ORIGIN = "https://w.example.org";
const A = "https://a.example.com/start";
const B = "https://a.example.com/next";

function redirect(status: number, location: string): Response {
  const r = new Response(null, { status, headers: { location } });
  (r as Response & { rawHeaders?: [string, string][] }).rawHeaders = [["location", location]];
  return r;
}

async function run(method: string, body: string | null = null): Promise<Response> {
  const armed: Promise<Response>[] = [];
  const headers = new Headers();
  if (body !== null) headers.set("content-type", "application/x-www-form-urlencoded");
  const ev = {
    request: {
      url: ORIGIN + encodeDestLegacy(A),
      method,
      mode: "cors",
      destination: "",
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers,
      clone() { return this; },
      async arrayBuffer() { return new TextEncoder().encode(body ?? "").buffer; },
    },
    clientId: "c1",
    resultingClientId: "",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  handleFetch(ev);
  return armed[0]!;
}

describe("redirect statuses and method rewrite follow the Fetch spec", () => {
  beforeEach(() => {
    transportMock.urls = [];
    transportMock.inits = [];
    transportMock.queue = [];
    cookiesResetForTests();
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    const mem = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (k: string) => mem.get(k),
        put: async (k: string, r: Response) => void mem.set(k, r),
        delete: async (k: string) => mem.delete(k),
        keys: async () => [...mem.keys()],
      }),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cookiesResetForTests();
  });

  it("a 303 keeps HEAD as HEAD", async () => {
    transportMock.queue = [redirect(303, B), new Response(null, { status: 200 })];
    const served = await run("HEAD");
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([A, B]);
    expect(transportMock.inits[1]?.method).toBe("HEAD");
  });

  it("a 303 turns POST into a body-less GET without a content-type", async () => {
    transportMock.queue = [redirect(303, B), new Response("ok", { status: 200 })];
    await run("POST", "a=1");
    expect(transportMock.urls).toEqual([A, B]);
    expect(transportMock.inits[1]?.method).toBe("GET");
    expect(transportMock.inits[1]?.headers?.get("content-type")).toBeNull();
    expect(transportMock.inits[1]?.body).toBeUndefined();
  });

  it.each([300, 305, 306])("a %i with a Location is not a redirect and is not followed", async (status) => {
    transportMock.queue = [redirect(status, B), new Response("never", { status: 200 })];
    const served = await run("GET");
    expect(transportMock.urls).toEqual([A]);
    expect(served.status).toBe(status);
  });
});
