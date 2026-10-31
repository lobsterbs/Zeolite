/* Issue #537: page-created blob workers get a safe virtual context.
   Chromium serves blob: worker scripts from the blob store with no
   fetch event, so the SW-side prelude injection cannot reach them. The
   page bootstrap wraps them instead (relay.ts zlWrapWorkerUrl), the SW
   serves the prelude from the /zl-bw/ route (request.ts), and the
   prelude itself wraps nested Worker construction inside worker realms
   (worker-prelude.ts). These tests cover the unit contracts of that
   chain; suite/e2e/blob-workers.mjs covers real Chromium. */

import { describe, expect, it } from "vitest";
import {
  applyRelay,
  zlBlobWrapSource,
  zlBwUrl,
  zlWrapWorkerUrl,
} from "../bootstrap/relay";
import { zlBwHead, zlBwTokenParse } from "../request";
import { encodeDest, setScheme } from "../codec";
import { installWorkerPrelude } from "../worker-prelude";

/* ---- request.ts: the /zl-bw/ token ------------------------------- */

describe("zlBwTokenParse (#537)", () => {
  const tok = encodeURIComponent(
    JSON.stringify({ s: "tok", b: "https://v.example/dir/page.html" }),
  );
  it("round-trips a page-built token", () => {
    expect(zlBwTokenParse("?c=" + tok)).toEqual({
      s: "tok",
      b: "https://v.example/dir/page.html",
    });
  });
  it("fails closed on missing, malformed or wrongly-typed tokens", () => {
    expect(zlBwTokenParse("")).toBeNull();
    expect(zlBwTokenParse("?x=1")).toBeNull();
    expect(zlBwTokenParse("?c=notjson")).toBeNull();
    expect(
      zlBwTokenParse("?c=" + encodeURIComponent(JSON.stringify({ s: 1, b: "x" }))),
    ).toBeNull();
    expect(
      zlBwTokenParse("?c=" + encodeURIComponent(JSON.stringify({ s: "x", b: "" }))),
    ).toBeNull();
    expect(
      zlBwTokenParse("?c=" + encodeURIComponent(JSON.stringify({ s: "", b: "x" }))),
    ).toBeNull();
  });
});

describe("zlBwHead (#537)", () => {
  it("bakes prefix, site token and virtual base as JSON globals", () => {
    const h = zlBwHead("/j/", "tok", "https://v.example/dir/page.html");
    expect(h).toContain('self.__ZL_PREFIX__="/j/"');
    expect(h).toContain('self.__ZL_SITE__="tok"');
    expect(h).toContain('self.__ZL_WORKER_BASE__="https://v.example/dir/page.html"');
  });
});

/* ---- relay.ts: the wrapper helpers -------------------------------- */

describe("blob worker wrapper helpers (#537)", () => {
  it("zlBwUrl round-trips through zlBwTokenParse", () => {
    const u = zlBwUrl("https://engine.host", "tok", "https://v.example/dir/page.html");
    expect(u.startsWith("https://engine.host/zl-bw/?c=")).toBe(true);
    expect(zlBwTokenParse(new URL(u).search)).toEqual({
      s: "tok",
      b: "https://v.example/dir/page.html",
    });
  });
  it("zlBlobWrapSource shapes the classic and module wrappers", () => {
    const prelude = "https://engine.host/zl-bw/?c=1";
    expect(zlBlobWrapSource("classic", prelude, "SRC")).toBe(
      'importScripts("' + prelude + '");\nSRC',
    );
    expect(zlBlobWrapSource("module", prelude, "SRC")).toBe(
      'await import("' + prelude + '");\nSRC',
    );
  });
});

/* ---- relay.ts: applyRelay wrapping through the ctor hooks --------- */

type Fn = (...a: unknown[]) => unknown;

class FakeWorkerCtor {
  static built: { u: string; o?: unknown }[] = [];
  constructor(public u: string, public o?: unknown) {
    (FakeWorkerCtor.built as { u: string; o?: unknown }[]).push({ u, o });
  }
  addEventListener() {}
  removeEventListener() {}
}
class FakeSharedWorkerCtor {
  static built: { u: string; o?: unknown }[] = [];
  port = { addEventListener() {}, removeEventListener() {} };
  constructor(public u: string, public o?: unknown) {
    (FakeSharedWorkerCtor.built as { u: string; o?: unknown }[]).push({ u, o });
  }
}

describe("applyRelay blob worker wrapping (#537)", () => {
  const G = globalThis as unknown as Record<string, unknown>;
  /* A controlled realm: fakes for every global the wrap touches, with
     save/restore so the process default comes back. */
  function withFakes(fn: (log: {
    blobs: { parts: unknown[]; opts?: { type: string } }[];
    objectUrls: string[];
    revoked: string[];
    xhrUrls: string[];
    xhrStatus: number;
  }) => void): void {
    const log = {
      blobs: [] as { parts: unknown[]; opts?: { type: string } }[],
      objectUrls: [] as string[],
      revoked: [] as string[],
      xhrUrls: [] as string[],
      xhrStatus: 200,
    };
    const savedAdd = G.addEventListener;
    const savedURL = G.URL;
    const savedBlob = G.Blob;
    const savedXHR = G.XMLHttpRequest;
    const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    G.addEventListener = () => {};
    class CaptureBlob {
      constructor(parts: unknown[], opts?: { type: string }) {
        log.blobs.push({ parts, opts });
      }
    }
    class FakeXHR {
      status = log.xhrStatus;
      responseText = "WK-SRC";
      open(_m: string, u: string) {
        log.xhrUrls.push(u);
      }
      send() {}
    }
    /* The wrap path reads `new URL(controller.scriptURL).origin` off
       the global URL, so the fake must stay constructible: extend the
       real URL and bolt the object-URL methods on as statics. */
    const BaseURL = (typeof savedURL === "function"
      ? savedURL
      : class {
          origin = "";
          constructor(_u: string) {}
        }) as unknown as new (u: string) => { origin: string };
    class FakeURL extends BaseURL {
      static createObjectURL(_b: unknown): string {
        const id = "blob:wrapped-" + (log.objectUrls.length + 1);
        log.objectUrls.push(id);
        return id;
      }
      static revokeObjectURL(u: string): void {
        log.revoked.push(u);
      }
    }
    G.URL = FakeURL;
    G.Blob = CaptureBlob;
    G.XMLHttpRequest = FakeXHR;
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { controller: { scriptURL: "https://engine.host/sw.js" } } },
      configurable: true,
      writable: true,
    });
    try {
      fn(log);
    } finally {
      G.addEventListener = savedAdd;
      G.URL = savedURL;
      G.Blob = savedBlob;
      if (savedXHR === undefined) delete G.XMLHttpRequest;
      else G.XMLHttpRequest = savedXHR;
      if (savedNav) Object.defineProperty(globalThis, "navigator", savedNav);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  }

  it("wraps a classic blob worker behind the /zl-bw/ prelude route", () => {
    withFakes((log) => {
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeWorkerCtor.built = [];
      applyRelay(w, "tok", "https://engine.host/j/page");
      const W = w.Worker as unknown as (u: string, o?: unknown) => unknown;
      new (W as unknown as new (u: string, o?: unknown) => unknown)(
        "blob:https://engine.host/orig",
      );
      expect(FakeWorkerCtor.built.length).toBe(1);
      expect(FakeWorkerCtor.built[0].u).toBe("blob:wrapped-1");
      expect(log.xhrUrls).toEqual(["blob:https://engine.host/orig"]);
      expect(log.blobs.length).toBe(1);
      expect(log.blobs[0].opts?.type).toBe("text/javascript");
      const src = String((log.blobs[0].parts as string[])[0]);
      expect(src.startsWith('importScripts("https://engine.host/zl-bw/?c=')).toBe(true);
      expect(src.endsWith("WK-SRC")).toBe(true);
      /* the token carries the site and the page base */
      const c = decodeURIComponent(src.split("?c=")[1].split('");\n')[0]);
      expect(JSON.parse(c)).toEqual({ s: "tok", b: "https://engine.host/j/page" });
      /* the wrapper entry is revoked after construction pins the load */
      expect(log.revoked).toEqual(["blob:wrapped-1"]);
    });
  });

  it("wraps a module blob worker with the module wrapper shape", () => {
    withFakes((log) => {
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeWorkerCtor.built = [];
      applyRelay(w, "tok", "https://engine.host/j/page");
      const W = w.Worker as unknown as new (u: string, o?: unknown) => unknown;
      new W("blob:https://engine.host/mod", { type: "module" });
      const src = String((log.blobs[0].parts as string[])[0]);
      expect(src.startsWith('await import("https://engine.host/zl-bw/?c=')).toBe(true);
    });
  });

  it("passes non-blob script URLs through untouched", () => {
    withFakes(() => {
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeWorkerCtor.built = [];
      applyRelay(w, "tok", "https://engine.host/j/page");
      const W = w.Worker as unknown as new (u: string, o?: unknown) => unknown;
      new W("https://up.example/w.js");
      expect(FakeWorkerCtor.built[0].u).toBe("https://up.example/w.js");
    });
  });

  it("falls back to the native constructor when the blob cannot be read", () => {
    withFakes((log) => {
      log.xhrStatus = 500;
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeWorkerCtor.built = [];
      applyRelay(w, "tok", "https://engine.host/j/page");
      const W = w.Worker as unknown as new (u: string, o?: unknown) => unknown;
      new W("blob:https://engine.host/gone");
      expect(FakeWorkerCtor.built[0].u).toBe("blob:https://engine.host/gone");
      expect(log.blobs.length).toBe(0);
    });
  });

  it("falls back when no service worker controller owns the page", () => {
    withFakes((log) => {
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeWorkerCtor.built = [];
      /* remove the controller: the wrap must fail closed */
      const ns = (globalThis as unknown as { navigator?: { serviceWorker?: { controller?: unknown } } })
        .navigator;
      const savedCtl = ns?.serviceWorker?.controller;
      (ns as { serviceWorker: { controller?: unknown } }).serviceWorker.controller = undefined;
      try {
        applyRelay(w, "tok", "https://engine.host/j/page");
        const W = w.Worker as unknown as new (u: string, o?: unknown) => unknown;
        new W("blob:https://engine.host/orig");
        expect(FakeWorkerCtor.built[0].u).toBe("blob:https://engine.host/orig");
        expect(log.blobs.length).toBe(0);
      } finally {
        (ns as { serviceWorker: { controller?: unknown } }).serviceWorker.controller = savedCtl;
      }
    });
  });

  it("shared workers cache the wrapper so same-site tabs share the context", () => {
    withFakes((log) => {
      const w: Record<string, unknown> = {
        Worker: FakeWorkerCtor,
        SharedWorker: FakeSharedWorkerCtor,
      };
      FakeSharedWorkerCtor.built = [];
      applyRelay(w, "tok", "https://engine.host/j/page");
      const S = w.SharedWorker as unknown as new (u: string, o?: unknown) => unknown;
      new S("blob:https://engine.host/sw1", { name: "n" });
      new S("blob:https://engine.host/sw1", { name: "n" });
      /* one wrapper for two constructions of the same script */
      expect(log.objectUrls.length).toBe(1);
      expect(FakeSharedWorkerCtor.built[0].u).toBe("blob:wrapped-1");
      expect(FakeSharedWorkerCtor.built[1].u).toBe("blob:wrapped-1");
      /* cached wrappers are never revoked */
      expect(log.revoked).toEqual([]);
      /* the scoped name still carries the site suffix */
      const o0 = FakeSharedWorkerCtor.built[0].o as { name?: string };
      expect(String(o0.name).includes("zl:tok:")).toBe(true);
    });
  });
});

/* ---- zlWrapWorkerUrl direct contract ------------------------------- */

describe("zlWrapWorkerUrl (#537 direct)", () => {
  const G = globalThis as unknown as Record<string, unknown>;
  it("returns null for non-blob inputs without touching globals", () => {
    expect(zlWrapWorkerUrl({}, "tok", "https://engine.host/j/page", "https://x/w.js")).toBeNull();
  });
});

/* ---- worker-prelude: nested Worker wrap inside a worker realm ------ */

describe("nested blob workers in a worker realm (#537)", () => {
  it("wraps, inherits the site and base, forwards relay shapes only", () => {
    const G = globalThis as unknown as Record<string, unknown>;
    const savedAdd = G.addEventListener;
    const savedPost = G.postMessage;
    const savedFetch = G.fetch;
    const savedWS = G.WebSocket;
    const savedPrefix = G.__ZL_PREFIX__;
    const savedSite = G.__ZL_SITE__;
    const savedBase = G.__ZL_WORKER_BASE__;
    const savedURLCtor = (G.URL as { createObjectURL?: unknown });
    const savedURLMk = savedURLCtor?.createObjectURL;
    const savedURLRv = (G.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    const savedBlobCtor = G.Blob;
    const savedWorker = G.Worker;
    const savedXHR = G.XMLHttpRequest;
    const savedLocation = G.location;

    const blobParts: { parts: unknown[]; opts?: { type: string } }[] = [];
    const madeUrls: string[] = [];
    const revoked: string[] = [];
    const xhrUrls: string[] = [];
    const posted: unknown[][] = [];
    const built: { u: string; o?: unknown }[] = [];
    const listeners: { t: string; l: Fn }[] = [];

    class FakeNestedWorker {
      constructor(u: string, o?: unknown) {
        built.push({ u, o });
      }
    }
    class FakeNestedXHR {
      status = 200;
      responseText = "CHILD-SRC";
      open(_m: string, u: string) {
        xhrUrls.push(u);
      }
      send() {}
    }
    class CaptureBlob {
      constructor(parts: unknown[], opts?: { type: string }) {
        blobParts.push({ parts, opts });
      }
    }
    try {
      G.addEventListener = (t: string, l: Fn) => {
        listeners.push({ t, l });
      };
      G.postMessage = (...a: unknown[]) => {
        posted.push(a);
      };
      G.fetch = () => Promise.resolve(new Response(""));
      G.WebSocket = function () {} as unknown;
      G.__ZL_PREFIX__ = "/j/";
      G.__ZL_SITE__ = "tok";
      G.__ZL_WORKER_BASE__ = "https://v.example/dir/page.html";
      G.location = { href: "blob:https://engine.host/uuid", origin: "https://engine.host" };
      (G.URL as unknown as Record<string, unknown>).createObjectURL = () => {
        madeUrls.push("blob:child-" + madeUrls.length);
        return "blob:child-" + madeUrls.length;
      };
      (G.URL as unknown as Record<string, unknown>).revokeObjectURL = (u: string) => {
        revoked.push(u);
      };
      G.Blob = CaptureBlob;
      G.Worker = FakeNestedWorker;
      G.XMLHttpRequest = FakeNestedXHR;

      setScheme("/j/");
      installWorkerPrelude(encodeDest("https://api.site/worker.js"));

      /* the nested ctor is wrapped */
      const W = G.Worker as unknown as new (u: string, o?: unknown) => unknown;
      expect(W).not.toBe(FakeNestedWorker);
      const wk = new W("blob:https://engine.host/orig");
      expect(wk instanceof FakeNestedWorker).toBe(true);
      expect(built.length).toBe(1);
      expect(built[0].u).toBe("blob:child-1");
      expect(xhrUrls).toEqual(["blob:https://engine.host/orig"]);
      const src = String((blobParts[0].parts as string[])[0]);
      expect(src.startsWith('importScripts("https://engine.host/zl-bw/?c=')).toBe(true);
      const c = decodeURIComponent(src.split("?c=")[1].split('");\n')[0]);
      expect(JSON.parse(c)).toEqual({ s: "tok", b: "https://v.example/dir/page.html" });
      expect(src.endsWith("CHILD-SRC")).toBe(true);
      expect(revoked).toEqual(["blob:child-1"]);

      /* non-blob nested URLs pass to the native ctor untouched */
      new W("https://up.example/w.js");
      expect(built[1].u).toBe("https://up.example/w.js");

      /* the nested relay forwarder moves only wrapper shapes */
      const fwd = listeners.find((x) => x.t === "message")?.l as
        | ((ev: { data: unknown; ports?: unknown[] }) => void)
        | undefined;
      expect(fwd).toBeTypeOf("function");
      const port = { postMessage: () => {} };
      fwd!({ data: { zl: "mint", msg: {} }, ports: [port] });
      expect(posted.length).toBe(1);
      expect((posted[0][0] as { zl: string }).zl).toBe("mint");
      posted.length = 0;
      fwd!({ data: { hello: "app data" }, ports: [] });
      expect(posted.length).toBe(0);
    } finally {
      G.addEventListener = savedAdd;
      if (savedPost === undefined) delete G.postMessage;
      else G.postMessage = savedPost;
      if (savedFetch !== undefined) G.fetch = savedFetch;
      if (savedWS === undefined) delete G.WebSocket;
      else G.WebSocket = savedWS;
      if (savedPrefix === undefined) delete G.__ZL_PREFIX__;
      else G.__ZL_PREFIX__ = savedPrefix;
      if (savedSite === undefined) delete G.__ZL_SITE__;
      else G.__ZL_SITE__ = savedSite;
      if (savedBase === undefined) delete G.__ZL_WORKER_BASE__;
      else G.__ZL_WORKER_BASE__ = savedBase;
      if (savedURLMk === undefined) delete (G.URL as unknown as Record<string, unknown>).createObjectURL;
      else (G.URL as unknown as Record<string, unknown>).createObjectURL = savedURLMk;
      if (savedURLRv === undefined) delete (G.URL as unknown as Record<string, unknown>).revokeObjectURL;
      else (G.URL as unknown as Record<string, unknown>).revokeObjectURL = savedURLRv;
      G.Blob = savedBlobCtor;
      if (savedWorker === undefined) delete G.Worker;
      else G.Worker = savedWorker;
      if (savedXHR === undefined) delete G.XMLHttpRequest;
      else G.XMLHttpRequest = savedXHR;
      if (savedLocation === undefined) delete G.location;
      else G.location = savedLocation;
      setScheme("/j/");
    }
  });
});
