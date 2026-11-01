import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { serveExtensionAsset, EXT_ROUTE } from "../serve";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";
import { handleExtPageCall } from "../pageapi";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: [], default_locale: "en" };
  return new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
}

/* Install ids derive from manifest bytes, so every install needs a
   unique manifest name. */
let seq = 0;

async function install(name: string): Promise<ExtensionRecord> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name + " #" + seq++));
  return extensions.get(id)!;
}

interface PortShape {
  name: string;
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(l: (m: unknown) => void): void };
  onDisconnect: { addListener(l: () => void): void };
}

describe("page-world runtime.connect ports (#560)", () => {
  it("delivers onConnect ports Chrome-shaped to the background", async () => {
    const rec = await install("PortsApi");
    const storage = {
      local: new ExtensionStorageArea(rec.id, "local", "local"),
      sync: new ExtensionStorageArea(rec.id, "sync", "sync"),
      session: new ExtensionStorageArea(rec.id, "session", "session"),
    };
    const messenger = new ExtensionMessenger();
    const api = buildApi(rec, { extensionId: rec.id, context: "background", url: null }, { messenger, storage });
    const got: unknown[] = [];
    const seen: unknown[] = [];
    let farSawDisc = 0;
    let callerSawDisc = 0;
    let far: PortShape | null = null;
    const rt = api.browser.runtime as unknown as { onConnect: { addListener(l: (port: unknown) => void): void } };
    rt.onConnect.addListener((port) => {
      const p = port as unknown as PortShape;
      expect(p.name).toBe("nm");
      expect(typeof p.onMessage.addListener).toBe("function");
      p.onMessage.addListener((m) => got.push(m));
      p.onDisconnect.addListener(() => {
        farSawDisc++;
      });
      far = p;
    });
    const caller = messenger.connect(rec.id, "nm", { extensionId: rec.id, context: "background", url: null });
    caller.onMessage((m) => seen.push(m));
    caller.onDisconnect(() => {
      callerSawDisc++;
    });
    caller.postMessage("x");
    expect(got).toEqual(["x"]);
    far!.postMessage("y");
    expect(seen).toEqual(["y"]);
    far!.disconnect();
    expect(farSawDisc).toBe(1);
    expect(callerSawDisc).toBe(1);
  });

  it("ships the runtime.connect stub in the page bridge", async () => {
    const rec = await install("PortsPage");
    const url = "https://sw.example" + EXT_ROUTE + rec.id + "/__page.js";
    const res = await serveExtensionAsset(new Request(url), new URL(url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(PAGE_BRIDGE_SOURCE).toContain("browser.runtime.connect =");
    expect(PAGE_BRIDGE_SOURCE).toContain("port: ");
    expect(PAGE_BRIDGE_SOURCE).toContain("onDisconnect");
    expect(body).toContain("runtime.connect");
  });

  it("still refuses ports over the RPC path", async () => {
    const rec = await install("PortsRefuse");
    const call = { path: ["runtime", "connect"], args: [] } as Parameters<typeof handleExtPageCall>[2];
    const r = await handleExtPageCall(rec, null, call);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ports are not supported");
  });
});
