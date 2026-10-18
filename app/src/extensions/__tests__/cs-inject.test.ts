import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { csInjectUrls } from "../../request";

const enc = new TextEncoder();

/* Non-all_frames cs package matching everything: the exact spec class
   that never ran in a host-app-embedded browsing pane before the
   parent-aware frame classification. */
function pkg(name: string, allFrames: boolean): Map<string, Uint8Array> {
  const manifest: Record<string, unknown> = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: [],
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["cs.js"],
        run_at: "document_idle",
        ...(allFrames ? { all_frames: true } : {}),
      },
    ],
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["cs.js", enc.encode("var csRan = 1;")],
  ]);
}

async function install(name: string, allFrames = false): Promise<string> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, allFrames));
  return id;
}

function frameReq(dest: string): Request {
  return new Request("https://sw.example/zl/route", {
    headers: { "sec-fetch-dest": dest },
  });
}

function bridges(id: string, req: Request, parentUrl?: string): boolean {
  return csInjectUrls("https://target.example/", req, parentUrl).some((u) => u.includes(id));
}

describe("content-script frame classification (host-embedded pane)", () => {
  it("runs a non-all_frames script in a host-embedded frame", async () => {
    const id = await install("CsHostPane");
    expect(bridges(id, frameReq("iframe"), "https://host.example/")).toBe(true);
  });

  it("keeps a genuine NAVH-parent subframe subframe", async () => {
    const id = await install("CsNavhParent");
    const navhParent = "https://sw.example/__zl_navh__/abc/https://parent.example/";
    expect(bridges(id, frameReq("iframe"), navhParent)).toBe(false);
  });

  it("keeps an engine-route parent subframe", async () => {
    const id = await install("CsEngineParent");
    expect(bridges(id, frameReq("iframe"), "https://sw.example/j/xyz")).toBe(false);
  });

  it("fails closed on absent, about:, and unparseable parents", async () => {
    const id = await install("CsFailClosed");
    expect(bridges(id, frameReq("iframe"))).toBe(false);
    expect(bridges(id, frameReq("iframe"), "about:blank")).toBe(false);
    expect(bridges(id, frameReq("iframe"), "::not a url::")).toBe(false);
  });

  it("all_frames scripts run in every frame regardless", async () => {
    const id = await install("CsAllFrames", true);
    expect(bridges(id, frameReq("iframe"), "https://sw.example/j/xyz")).toBe(true);
  });
});
