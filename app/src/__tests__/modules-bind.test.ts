import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { idbClear, openDb, STORE_MODULES } from "../extensions/idb";
import { DIAG } from "../diag";

vi.mock("../diag", () => ({ DIAG: { emit: vi.fn() } }));

const FIXTURES = new URL("../modules/fixtures/", import.meta.url);

interface ModuleFile {
  manifest: Record<string, unknown>;
  sig: string;
}

function fixture(name: string): ModuleFile {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as ModuleFile;
}

function emitted(prefix: string): number {
  const calls = (DIAG.emit as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls.filter((c) => {
    const e = c[0] as { message?: string };
    return typeof e.message === "string" && e.message.startsWith(prefix);
  }).length;
}

/* Every test gets a fresh module graph: the bind seam keeps per-boot
   state (the bound map, the warned set) at module scope. */
beforeEach(() => {
  (DIAG.emit as unknown as ReturnType<typeof vi.fn>).mockClear();
  vi.resetModules();
});

async function fresh(): Promise<{
  plugins: typeof import("../plugins");
  bind: typeof import("../modules/bind");
  registry: typeof import("../modules/registry");
  observer: typeof import("../modules/fixtures/test-observer");
}> {
  /* Each fresh() is also a simulated reboot: the bind seam keeps
     per-boot state at module scope, so the module graph must be
     reset here again, not only between tests. */
  vi.resetModules();

  const db = await openDb();
  await idbClear(db, STORE_MODULES);
  const plugins = await import("../plugins");
  const bind = await import("../modules/bind");
  const registry = await import("../modules/registry");
  const observer = await import("../modules/fixtures/test-observer");
  const reg = await import("../plugins/registry");
  (bind.MODULE_IDENTITIES as Record<string, string>)["test-observer"] = "im.zeolite.test-observer";
  (reg.REGISTRY as Record<string, unknown>)["test-observer"] = observer.register;
  return { plugins, bind, registry, observer };
}

describe("modules/bind", () => {
  it("keeps the source seam: plugins.ts consults boundModuleHooks", () => {
    const src = readFileSync(new URL("../plugins.ts", import.meta.url), "utf8");
    expect(src).toContain("boundModuleHooks");
  });

  it("a claimed but uninstalled name fails closed with ONE bounded diag", async () => {
    const { plugins } = await fresh();
    expect(await plugins.loadPlugin("test-observer")).toBeNull();
    expect(await plugins.loadPlugin("test-observer")).toBeNull();
    expect(emitted("signed module is not installed: im.zeolite.test-observer")).toBe(1);
  });

  it("an unclaimed name keeps the legacy static path unchanged", async () => {
    const { plugins } = await fresh();
    const reg = await import("../plugins/registry");
    (reg.REGISTRY as Record<string, unknown>)["legacy-x"] = (h: { onRequest?: () => { headers: Record<string, string> } }) => {
      h.onRequest = () => ({ headers: { "x-legacy": "one" } });
    };
    const hooks = await plugins.loadPlugin("legacy-x");
    expect(hooks).not.toBeNull();
    expect(hooks?.onRequest).toBeTypeOf("function");
    const headers = new Headers();
    const out = hooks?.onRequest?.({ url: "https://example.test/", headers: {} });
    if (out?.headers) for (const [k, v] of Object.entries(out.headers)) headers.set(k, v);
    expect(headers.get("x-legacy")).toBe("one");
    expect(emitted("site plugin is not in the build registry: legacy-x")).toBe(0);
  });

  it("observe-only binding observes but never edits", async () => {
    const { plugins, registry, bind, observer } = await fresh();
    const f = fixture("test-observer.module.json");
    const r = await registry.install({ manifest: f.manifest, sig: f.sig, granted: ["observe:requests"] });
    expect(r.ok).toBe(true);
    await bind.bindInstalledModules();
    expect(await plugins.loadPlugin("test-observer")).not.toBeNull();
    const headers = new Headers({ "x-real": "1" });
    await plugins.applyOnRequest(["test-observer"], "https://example.test/", headers);
    expect(headers.get("x-mod-observer")).toBeNull();
    expect(headers.get("x-real")).toBe("1");
    await plugins.applyOnResponse(["test-observer"], "https://example.test/", 204, new Headers());
    expect(observer.seen.statuses).toContain(204);
  });

  it("a modify:requests grant lets the hook edit request headers", async () => {
    const { plugins, registry, bind } = await fresh();
    const f = fixture("test-observer.module.json");
    await registry.install({ manifest: f.manifest, sig: f.sig, granted: ["observe:requests", "modify:requests"] });
    await bind.bindInstalledModules();
    const headers = new Headers();
    await plugins.applyOnRequest(["test-observer"], "https://example.test/", headers);
    expect(headers.get("x-mod-observer")).toBe("one");
  });

  it("a declared grant set without observe binds nothing", async () => {
    const { plugins, registry, bind } = await fresh();
    const f = fixture("test-observer.module.json");
    await registry.install({ manifest: f.manifest, sig: f.sig, granted: ["modify:requests"] });
    await bind.bindInstalledModules();
    expect(await plugins.loadPlugin("test-observer")).toBeNull();
    expect(await plugins.applyOnRequest(["test-observer"], "u", new Headers())).toBeUndefined();
  });

  it("revoke unbinds on the next boot", async () => {
    const first = await fresh();
    const f = fixture("test-observer.module.json");
    await first.registry.install({ manifest: f.manifest, sig: f.sig, granted: ["observe:requests"] });
    await first.bind.bindInstalledModules();
    expect(await first.plugins.loadPlugin("test-observer")).not.toBeNull();
    await first.registry.revoke("im.zeolite.test-observer");
    /* The next boot re-reads the store: the revoked record is excluded
       from installedRecords, so the name fails closed. */
    const next = await fresh();
    await next.bind.bindInstalledModules();
    expect(await next.plugins.loadPlugin("test-observer")).toBeNull();
  });
});
