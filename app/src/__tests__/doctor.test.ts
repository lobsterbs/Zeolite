import { describe, expect, it, vi } from "vitest";
import {
  buildDoctor, doctorKdl, observeDoctorBoot, probeDoctorAssets,
  type DoctorEvidence, type DoctorCheck,
} from "../doctor";
import { parseKdl } from "../kdl";

const evidence = (overrides: Partial<DoctorEvidence> = {}): DoctorEvidence => ({
  engineVersion: "3.0 Diamond",
  boot: "ready",
  scriptUrl: "https://engine.example/zlsw/sw.js",
  registrationScope: "https://engine.example/",
  selectedEngine: "libcurl",
  degraded: false,
  transport: "idle",
  relay: false,
  alternateWisp: false,
  primaryWisp: "wss://alice:secret@engine.example/wisp/?access_token=SECRET",
  policy: "not-loaded",
  rules: "not-loaded",
  siteconfig: "not-loaded",
  ...overrides,
});
const check = (r: ReturnType<typeof buildDoctor>, code: string): DoctorCheck => {
  const c = r.checks.find(c => c.code === code);
  expect(c).toBeDefined();
  return c!;
};

describe("Zeolite Doctor passive evidence model (#495)", () => {
  it("reports unknown instead of claiming all checks passed from a successful boot", () => {
    const r = buildDoctor(evidence());
    expect(r.schemaVersion).toBe(1);
    expect(r.ok).toBe(true); // no known failures, not a claim that all checks pass
    expect(check(r, "worker.running").status).toBe("pass");
    expect(check(r, "worker.client-control").status).toBe("unknown");
    expect(check(r, "engine.initialization").status).toBe("unknown");
    expect(check(r, "transport.lifecycle").status).toBe("unknown");
    expect(check(r, "transport.wisp-auth").status).toBe("unknown");
    expect(check(r, "config.policy").status).toBe("unknown");
    expect(check(r, "assets.rewriter-wasm").status).toBe("skipped");
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(JSON.stringify(r)).not.toContain("alice");
  });

  it("reports actual failed initialization and a previously observed dead transport", () => {
    const r = buildDoctor(evidence({ degraded: true, boot: "failed", transport: "dead" }));
    expect(r.ok).toBe(false);
    expect(check(r, "worker.boot").status).toBe("fail");
    expect(check(r, "engine.initialization").status).toBe("fail");
    expect(check(r, "transport.lifecycle").status).toBe("fail");
  });

  it("does not conflate configured, connecting, connected or auth success", () => {
    for (const [state, result] of [["idle", "unknown"], ["connecting", "warn"], ["connected", "pass"], ["dead", "fail"]] as const) {
      const r = buildDoctor(evidence({ transport: state }));
      expect(check(r, "transport.lifecycle").status).toBe(result);
      expect(check(r, "transport.wisp-auth").status).toBe("unknown");
      expect(check(r, "transport.wisp-endpoint").summary).toContain("unverified");
    }
    expect(check(buildDoctor(evidence({ primaryWisp: "not-a-url" })), "transport.wisp-endpoint").status).toBe("fail");
    expect(check(buildDoctor(evidence({ primaryWisp: "ws://localhost:1234/wisp/" })), "transport.wisp-endpoint").status).toBe("warn");
  });

  it("only verifies host version and scope when supplied with comparable observations", () => {
    let r = buildDoctor(evidence({ expectedScope: "https://engine.example/", expectedVersion: "3.0 Diamond" }));
    expect(check(r, "worker.scope").status).toBe("pass");
    expect(check(r, "bundle.version").status).toBe("pass");
    r = buildDoctor(evidence({ expectedScope: "https://engine.example/zlsw/", expectedVersion: "older" }));
    expect(check(r, "worker.scope").status).toBe("fail");
    expect(check(r, "bundle.version").status).toBe("fail");
    r = buildDoctor(evidence({ expectedScope: "https://engine.example/", registrationScope: undefined }));
    expect(check(r, "worker.scope").status).toBe("unknown");
  });

  it("distinguishes missing, malformed, unavailable and unloaded KDL files without fetching", () => {
    let r = buildDoctor(evidence({ policy: "loaded", rules: "missing", siteconfig: "invalid" }));
    expect(check(r, "config.policy").status).toBe("pass");
    expect(check(r, "config.rules").status).toBe("warn");
    expect(check(r, "config.siteconfig").status).toBe("fail");
    r = buildDoctor(evidence({ policy: "unavailable", rules: "not-loaded" }));
    expect(check(r, "config.policy").status).toBe("unknown");
    expect(check(r, "config.rules").status).toBe("unknown");
  });

  it("serializes parseable KDL with no raw endpoint credentials or secret-bearing URL fields", () => {
    const r = buildDoctor(evidence({ expectedVersion: 'bad";\nextra "injected"', primaryWisp: "wss://bob:pw@engine.example/wisp/?password=hunter2" }));
    const src = doctorKdl(r);
    const nodes = parseKdl(src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("zeolite-doctor");
    expect(nodes[0].props.version).toBe(1);
    expect(nodes[0].children).toHaveLength(r.checks.length);
    expect(nodes[0].children.find(n => n.args[0] === "bundle.version")?.props.status).toBe("fail");
    expect(src).not.toContain("hunter2");
    expect(src).not.toContain("bob");
    expect(src).not.toContain("pw@");
    expect(nodes.every(n => n.name === "zeolite-doctor")).toBe(true);
  });
});

describe("Zeolite Doctor explicit same-origin asset probes (#495)", () => {
  it("never probes an invalid worker URL", async () => {
    const f = vi.fn();
    const r = await probeDoctorAssets("data:text/plain,hi", f);
    expect(f).not.toHaveBeenCalled();
    expect(r.every(x => x.status === "unknown")).toBe(true);
  });

  it("checks only four static sibling HEAD endpoints, with no credential transfer", async () => {
    const seen: Array<[string, RequestInit]> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      seen.push([url, init]);
      return new Response(null, { status: 200, headers: {
        "content-type": url.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      } });
    });
    const r = await probeDoctorAssets("https://engine.example/zlsw/sw.js", fetcher as typeof fetch);
    expect(r).toHaveLength(4);
    expect(r.every(x => x.status === "pass")).toBe(true);
    expect(seen.map(x => x[0])).toEqual([
      "https://engine.example/zlsw/bootstrap.js",
      "https://engine.example/zlsw/codec.js",
      "https://engine.example/zlsw/worker-prelude.js",
      "https://engine.example/zlsw/rewriter_wasm_bg.wasm",
    ]);
    for (const [url, init] of seen) {
      expect(new URL(url).origin).toBe("https://engine.example");
      expect(init.method).toBe("HEAD");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("manual");
      expect(init.cache).toBe("no-store");
    }
  });

  it("detects missing bundle and HTML SPA fallback without treating other network failures as confirmed 404s", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/bootstrap.js")) return new Response(null, { status: 404 });
      if (url.endsWith("/codec.js")) return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/worker-prelude.js")) return new Response(null, { status: 405 });
      throw new Error("private-token");
    });
    const r = await probeDoctorAssets("https://engine.example/zlsw/sw.js", fetcher as typeof fetch);
    expect(r.map(c => c.status)).toEqual(["fail", "fail", "unknown", "unknown"]);
    expect(JSON.stringify(r)).not.toContain("private-token");
  });

  it("does not claim a successful handshake, configuration, or page identity from asset HEAD responses", async () => {
    const r = buildDoctor(evidence(), [{ code: "assets.bootstrap", status: "pass", summary: "Expected MIME" }]);
    expect(check(r, "transport.wisp-auth").status).toBe("unknown");
    expect(check(r, "worker.client-control").status).toBe("unknown");
  });
});

describe("Doctor boot guard (#495)", () => {
  it("observes ready and rejected promises", async () => {
    await expect(observeDoctorBoot(Promise.resolve())).resolves.toBe("ready");
    await expect(observeDoctorBoot(Promise.reject(new Error("private-token")))).resolves.toBe("failed");
  });
  it("returns timeout for a hung boot without rejecting", async () => {
    vi.useFakeTimers();
    try {
      const p = observeDoctorBoot(new Promise(() => {}), 75);
      await vi.advanceTimersByTimeAsync(80);
      await expect(p).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
