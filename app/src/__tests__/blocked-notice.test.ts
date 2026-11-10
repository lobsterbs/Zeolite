import { describe, expect, it } from "vitest";
import { blockedPageNotice } from "../request";

/* #643: the engine posts one zl:blockedNotice per (client, destination)
   so a blocked endpoint retry storm reads as a deliberate engine
   decision, not a dead worker. The deliver seam is injected: these
   units prove the dedupe, the bound and the message shape, never a
   real client lookup. */

describe("blockedPageNotice (#643)", () => {
  it("delivers once per (client, destination), with the honest message shape", () => {
    const sent: Array<{ id: string; msg: unknown }> = [];
    const deliver = (id: string, msg: unknown) => { sent.push({ id, msg }); };
    expect(blockedPageNotice("bn-c1", "https://x.test/log", "rules", deliver)).toBe(true);
    expect(blockedPageNotice("bn-c1", "https://x.test/log", "rules", deliver)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      id: "bn-c1",
      msg: { type: "zl:blockedNotice", dest: "https://x.test/log", by: "rules" },
    });
  });

  it("delivers again for a different destination or a different client", () => {
    const sent: string[] = [];
    const deliver = (id: string) => { sent.push(id); };
    expect(blockedPageNotice("bn-c2", "https://x.test/a", "rules", deliver)).toBe(true);
    expect(blockedPageNotice("bn-c2", "https://x.test/b", "csp", deliver)).toBe(true);
    expect(blockedPageNotice("bn-c3", "https://x.test/a", "intercept", deliver)).toBe(true);
    expect(sent).toEqual(["bn-c2", "bn-c2", "bn-c3"]);
  });

  it("never delivers without a client id or a destination", () => {
    let calls = 0;
    const deliver = () => { calls += 1; };
    expect(blockedPageNotice(undefined, "https://x.test/a", "rules", deliver)).toBe(false);
    expect(blockedPageNotice(null, "https://x.test/a", "rules", deliver)).toBe(false);
    expect(blockedPageNotice("", "https://x.test/a", "rules", deliver)).toBe(false);
    expect(blockedPageNotice("bn-c4", "", "rules", deliver)).toBe(false);
    expect(calls).toBe(0);
  });

  it("evicts the oldest keys at the bound so memory stays capped", () => {
    let emitted = 0;
    const deliver = () => { emitted += 1; };
    for (let i = 0; i < 300; i += 1) {
      expect(blockedPageNotice("bn-cap", "https://cap.test/" + i, "rules", deliver)).toBe(true);
    }
    expect(emitted).toBe(300);
    /* the first destination was evicted at the bound: it notifies again */
    expect(blockedPageNotice("bn-cap", "https://cap.test/0", "rules", deliver)).toBe(true);
    expect(emitted).toBe(301);
  });
});
