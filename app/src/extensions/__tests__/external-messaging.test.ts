import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger, senderOrigin } from "../messaging";
import type { ExternallyConnectableSpec } from "../types";

/* #518: extension-to-extension external messaging over
   externally_connectable.ids. The messenger is tested directly (the
   gate lives there); buildApi is probed for the Firefox-shaped
   overload routing. */

function messengerFor(
  manifests: Record<string, { externallyConnectable: ExternallyConnectableSpec | null } | null>,
): ExtensionMessenger {
  const m = new ExtensionMessenger();
  m.setExternallyConnectableProvider((id) => manifests[id] ?? null);
  return m;
}

const sender = (extId: string) => ({
  extensionId: extId,
  id: extId,
  context: "background" as const,
  url: null,
});

describe("external messaging gate (#518)", () => {
  it("delivers a cross-extension send to onMessageExternal with the real sender", async () => {
    const m = messengerFor({
      target: { externallyConnectable: { ids: ["sender@vendor.example"], matches: [] } },
      other: null,
    });
    const seen: Array<{ msg: unknown; sender: unknown }> = [];
    m.onMessageExternal("target", (msg, s, respond) => {
      seen.push({ msg, sender: s });
      respond("pong");
    });
    const reply = await m.sendMessageExternal("target", sender("sender@vendor.example"), { ping: 1 });
    expect(reply).toBe("pong");
    expect(seen).toHaveLength(1);
    expect(seen[0].msg).toEqual({ ping: 1 });
    const s = seen[0].sender as { id?: string; extensionId: string; origin?: string | null };
    expect(s.id).toBe("sender@vendor.example");
    expect(s.extensionId).toBe("sender@vendor.example");
  });

  it("honors * glob id patterns", async () => {
    const m = messengerFor({
      target: { externallyConnectable: { ids: ["*@vendor.example"], matches: [] } },
    });
    let fired = 0;
    m.onMessageExternal("target", (_msg, _s, respond) => {
      fired++;
      respond();
    });
    await m.sendMessageExternal("target", sender("a@vendor.example"), "x");
    await expect(m.sendMessageExternal("target", sender("a@other.example"), "x")).rejects.toThrow(/Receiving end does not exist/);
    expect(fired).toBe(1);
  });

  it("rejects when the target lists no ids, or does not exist, or has no listener", async () => {
    const m = messengerFor({
      closed: null,
      open: { externallyConnectable: { ids: ["*"], matches: [] } },
      silent: { externallyConnectable: { ids: ["*"], matches: [] } },
    });
    await expect(m.sendMessageExternal("closed", sender("s@x"), "m")).rejects.toThrow(/Receiving end does not exist/);
    await expect(m.sendMessageExternal("missing", sender("s@x"), "m")).rejects.toThrow(/Receiving end does not exist/);
    // admissible target without listeners: same Gecko error class
    await expect(m.sendMessageExternal("open", sender("s@x"), "m")).rejects.toThrow(/Receiving end does not exist/);
    await expect(m.sendMessageExternal("silent", sender("s@x"), "m")).rejects.toThrow(/Receiving end does not exist/);
  });

  it("refuses the messenger-internal cross-extension path unchanged", async () => {
    const m = messengerFor({ target: { externallyConnectable: { ids: ["*"], matches: [] } } });
    m.onMessage("target", (_msg, _s, respond) => respond("ok"));
    await expect(m.sendMessage("target", sender("other@x"), "m")).rejects.toThrow(/cross-extension/);
  });

  it("connectExternal pairs a duplex port into onConnectExternal", async () => {
    const m = messengerFor({ target: { externallyConnectable: { ids: ["s@x"], matches: [] } } });
    const ports: Array<{ name: string; sender: { id?: string } }> = [];
    m.onConnectExternal("target", (p) => {
      ports.push(p as unknown as { name: string; sender: { id?: string } });
      p.onMessage((msg) => p.postMessage({ echo: msg }));
    });
    const caller = m.connectExternal("target", "ch", sender("s@x"));
    expect(ports).toHaveLength(1);
    expect(ports[0].name).toBe("ch");
    expect(ports[0].sender.id).toBe("s@x");
    const got: unknown[] = [];
    caller.onMessage((msg) => got.push(msg));
    caller.postMessage("hi");
    expect(got).toEqual([{ echo: "hi" }]);
    // unadmitted target refuses
    expect(() => m.connectExternal("closed", "ch", sender("s@x"))).toThrow(/Receiving end does not exist/);
  });

  it("clear() drops external listeners with the rest", () => {
    const m = messengerFor({ target: { externallyConnectable: { ids: ["*"], matches: [] } } });
    m.onMessageExternal("target", () => undefined);
    m.onConnectExternal("target", () => undefined);
    m.clear("target");
    return expect(m.sendMessageExternal("target", sender("s@x"), "m")).rejects.toThrow(/Receiving end does not exist/);
  });
});

describe("senderOrigin (#518)", () => {
  it("answers the origin of parseable urls and null otherwise", () => {
    expect(senderOrigin("https://page.example/a?b=1")).toBe("https://page.example");
    expect(senderOrigin("http://sub.page.example:8080/x")).toBe("http://sub.page.example:8080");
    expect(senderOrigin(null)).toBeNull();
    expect(senderOrigin("not a url")).toBeNull();
  });
});

describe("runtime.sendMessage / connect overloads (#518)", () => {
  it("routes a two-arg string send cross-extension and a one-arg send internally", async () => {
    await extensions.startup();
    const enc = new TextEncoder();
    const files = (extra: Record<string, unknown>) =>
      new Map<string, Uint8Array>([
        ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 3, name: "X", version: "1.0", ...extra }))],
      ]);
    const senderRec = extensions.get((await extensions.installFiles(files({}))).id)!;
    const targetRec = extensions.get(
      (await extensions.installFiles(files({ externally_connectable: { ids: ["*"] } }))).id,
    )!;
    const messenger = new ExtensionMessenger();
    messenger.setExternallyConnectableProvider((id) => {
      const rec = extensions.get(id);
      return rec ? { externallyConnectable: rec.externallyConnectable } : null;
    });
    const mkApi = (rec: typeof senderRec) =>
      buildApi(
        rec,
        { extensionId: rec.id, id: rec.id, context: "background", url: null },
        { messenger, storage: { local: null as never, sync: null as never, session: null as never } },
      );
    const targetApi = mkApi(targetRec);
    const senderApi = mkApi(senderRec);
    const targetRuntime = targetApi.browser.runtime as unknown as {
      onMessageExternal: { addListener: (l: unknown) => void };
      onMessage: { addListener: (l: unknown) => void };
    };
    const senderRuntime = senderApi.browser.runtime as unknown as {
      sendMessage: (...args: unknown[]) => Promise<unknown>;
      onMessage: { addListener: (l: unknown) => void };
    };
    const seen: unknown[] = [];
    targetRuntime.onMessageExternal.addListener((msg: unknown) => {
      seen.push(msg);
      return "ext-reply";
    });
    // id overload: delivered externally to the target
    const reply = await senderRuntime.sendMessage(t_id(targetRec), "hello");
    expect(reply).toBe("ext-reply");
    expect(seen).toEqual(["hello"]);
    // plain send: internal onMessage, not external
    let internalFired = false;
    senderRuntime.onMessage.addListener(() => {
      internalFired = true;
      return "inner";
    });
    const internalReply = await senderRuntime.sendMessage("solo-string");
    expect(internalReply).toBe("inner");
    expect(internalFired).toBe(true);
    // the target's INTERNAL onMessage did not fire for the external send
    let targetInternalFired = false;
    targetRuntime.onMessage.addListener(() => {
      targetInternalFired = true;
      return "x";
    });
    await senderRuntime.sendMessage(t_id(targetRec), "again");
    expect(targetInternalFired).toBe(false);
    expect(seen).toEqual(["hello", "again"]);
  });
});

function t_id(rec: { id: string }): string {
  return rec.id;
}
