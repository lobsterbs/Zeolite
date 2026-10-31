import { afterEach, describe, expect, it } from "vitest";
import { applyCookie, deletionShaped } from "../bootstrap/cookie";

/* #534: the document.cookie optimistic copy must honor a
   deletion-shaped write immediately (the consistency contract), and
   the jar-reply refresh keeps the copy eventually consistent. The
   channel plumbing runs against the real MessageChannel the shim
   creates; the fake controller only captures the transferred port. */

type PortLike = { onmessage: ((ev: { data: unknown }) => void) | null; postMessage(d: unknown): void };

function installRealm(): { jarPort: PortLike | null; doc: Record<string, unknown> } {
  const captured: { port: PortLike | null } = { port: null };
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        controller: {
          postMessage: (_msg: unknown, transfer?: unknown[]) => {
            if (transfer && transfer.length) captured.port = transfer[0] as PortLike;
          },
        },
      },
    },
    configurable: true,
    writable: true,
  });
  const doc: Record<string, unknown> = {};
  applyCookie("site-token", doc as unknown as Document);
  if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
  return { jarPort: captured.port, doc };
}

const settle = () => new Promise<void>((res) => setTimeout(res, 0));

describe("deletionShaped (#534)", () => {
  it("detects max-age 0 and negative", () => {
    expect(deletionShaped("b=; Max-Age=0")).toBe(true);
    expect(deletionShaped("b=; max-age=-1")).toBe(true);
  });
  it("detects a past Expires and keeps a future one", () => {
    expect(deletionShaped("b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT")).toBe(true);
    expect(deletionShaped("b=; Expires=Fri, 01 Jan 2100 00:00:00 GMT")).toBe(false);
  });
  it("treats a plain write and an unparsable date as not a deletion", () => {
    expect(deletionShaped("a=3")).toBe(false);
    expect(deletionShaped("b=; Expires=not-a-date")).toBe(false);
  });
});

describe("document.cookie optimistic copy (#534)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__zl;
  });

  it("serves the jar view after the reply lands", async () => {
    const { jarPort, doc } = installRealm();
    jarPort!.postMessage({ cookie: "a=1; b=2" });
    await settle();
    expect((doc as unknown as Document).cookie).toBe("a=1; b=2");
  });

  it("a deletion-shaped write removes the name immediately (#534 contract)", async () => {
    const { jarPort, doc } = installRealm();
    jarPort!.postMessage({ cookie: "a=1; b=2" });
    await settle();
    (doc as unknown as Document).cookie = "b=; Max-Age=0";
    /* no jar reply has landed: the stale value must already be gone */
    expect((doc as unknown as Document).cookie).toBe("a=1");
  });

  it("a plain write stays optimistic and a later jar reply corrects", async () => {
    const { jarPort, doc } = installRealm();
    jarPort!.postMessage({ cookie: "a=1" });
    await settle();
    (doc as unknown as Document).cookie = "a=2";
    expect((doc as unknown as Document).cookie).toBe("a=2");
    jarPort!.postMessage({ cookie: "a=9" });
    await settle();
    expect((doc as unknown as Document).cookie).toBe("a=9");
  });
});
