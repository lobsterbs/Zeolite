import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ALARMS } from "../alarms";
import type { Alarm } from "../alarms";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions }))],
  ]);
}

async function apiFor(name: string, permissions: string[]) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name, permissions));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage, manager: m },
  );
  return { id, api };
}

describe("AlarmRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ALARMS.resetForTests();
  });
  afterEach(() => {
    ALARMS.resetForTests();
    vi.useRealTimers();
  });

  it("create/get/getAll/clear follow the API shape", () => {
    ALARMS.create("e1", "tick", { delayInMinutes: 1 });
    expect(ALARMS.get("e1", "tick")?.name).toBe("tick");
    expect(ALARMS.getAll("e1")).toHaveLength(1);
    expect(ALARMS.clear("e1", "tick")).toBe(true);
    expect(ALARMS.get("e1", "tick")).toBeUndefined();
    expect(ALARMS.clearAll("e1")).toBe(false);
  });

  it("fires onAlarm after the delay and wakes the background", async () => {
    const wakes: string[] = [];
    ALARMS.setWake(async (id) => {
      wakes.push(id);
    });
    const seen: Alarm[] = [];
    ALARMS.onAlarm("e2", (a) => seen.push(a));
    ALARMS.create("e2", "once", { delayInMinutes: 0.1 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(seen.map((a) => a.name)).toEqual(["once"]);
    expect(wakes).toEqual(["e2"]);
    expect(ALARMS.get("e2", "once")).toBeUndefined();
  });

  it("periodic alarms reschedule and survive past fires", async () => {
    ALARMS.setWake(async () => undefined);
    const seen: Alarm[] = [];
    ALARMS.onAlarm("e3", (a) => seen.push(a));
    ALARMS.create("e3", "loop", { periodInMinutes: 0.1 });
    await vi.advanceTimersByTimeAsync(6_500);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(ALARMS.get("e3", "loop")).toBeDefined();
  });

  it("listener errors are isolated", async () => {
    ALARMS.setWake(async () => undefined);
    const seen: Alarm[] = [];
    ALARMS.onAlarm("e4", () => {
      throw new Error("boom");
    });
    ALARMS.onAlarm("e4", (a) => seen.push(a));
    ALARMS.create("e4", "x", { delayInMinutes: 0.01 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toHaveLength(1);
  });

  it("drop clears everything an extension owned", () => {
    ALARMS.create("e5", "gone", { delayInMinutes: 5 });
    ALARMS.drop("e5");
    expect(ALARMS.getAll("e5")).toHaveLength(0);
  });
});

describe("browser.alarms", () => {
  afterEach(() => {
    ALARMS.resetForTests();
    vi.useRealTimers();
  });

  it("is mounted only with the alarms permission", async () => {
    const withPerm = await apiFor("AlmPerm", ["alarms"]);
    const bare = await apiFor("AlmBare", []);
    expect((withPerm.api.browser as Record<string, unknown>).alarms).toBeDefined();
    expect((bare.api.browser as Record<string, unknown>).alarms).toBeUndefined();
  });

  it("create + onAlarm deliver through the API", async () => {
    vi.useFakeTimers();
    ALARMS.resetForTests();
    const { api } = await apiFor("AlmApi", ["alarms"]);
    const alarms = (api.browser as Record<string, any>).alarms;
    const seen: Alarm[] = [];
    alarms.onAlarm.addListener((a: Alarm) => seen.push(a));
    alarms.create("named", { delayInMinutes: 0.05 });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(seen.map((a: Alarm) => a.name)).toEqual(["named"]);
    expect(await alarms.get("named")).toBeUndefined();
  });
});
