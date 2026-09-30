import { describe, expect, it } from "vitest";
import { buildRegex, matchPositions, stepOrdinal } from "../find-core";
import { applyFindLoad } from "../bootstrap/findload";

describe("buildRegex", () => {
  it("returns null for an empty pattern", () => {
    expect(buildRegex("", {})).toBeNull();
  });

  it("escapes regex metacharacters, so input never becomes syntax", () => {
    const re = buildRegex("a.b+c*d", {});
    expect(re).not.toBeNull();
    expect("axbycwtd".match(re!)).toBeNull();
    expect("a.b+c*d".match(re!)).toEqual(["a.b+c*d"]);
    expect(buildRegex("^start(.*)$", {})!.test("^start(.*)$")).toBe(true);
  });

  it("is case-insensitive by default and sensitive on request", () => {
    const re = buildRegex("word", {});
    expect("wOrD here".match(re!)).toEqual(["wOrD"]);
    const cs = buildRegex("word", { caseSensitive: true })!;
    expect("wOrD here".match(cs)).toBeNull();
    expect("a word here".match(cs)).toEqual(["word"]);
  });

  it("wraps wholeWord in word boundaries", () => {
    const re = buildRegex("cat", { wholeWord: true })!;
    expect("cat".match(re)).toEqual(["cat"]);
    expect("catapult".match(re)).toBeNull();
    expect("concat".match(re)).toBeNull();
    expect("cat, cat!".match(re)).toEqual(["cat", "cat"]);
  });
});

describe("matchPositions", () => {
  it("finds every non-overlapping occurrence left to right", () => {
    expect(matchPositions("ababab", buildRegex("ab", {})!)).toEqual([0, 2, 4]);
    expect(matchPositions("aaa", buildRegex("a", {})!)).toEqual([0, 1, 2]);
    expect(matchPositions("aaa", buildRegex("aa", {})!)).toEqual([0]);
  });

  it("starts fresh on every call (no shared lastIndex state)", () => {
    const re = buildRegex("x", {})!;
    expect(matchPositions("x", re)).toEqual([0]);
    expect(matchPositions("x", re)).toEqual([0]);
  });
});

describe("stepOrdinal", () => {
  it("never moves without matches", () => {
    expect(stepOrdinal(-1, 0, 1, true)).toBe(-1);
    expect(stepOrdinal(1, 0, -1, true)).toBe(-1);
  });

  it("enters at the first match forwards and the last backwards", () => {
    expect(stepOrdinal(-1, 3, 1, false)).toBe(0);
    expect(stepOrdinal(-1, 3, -1, false)).toBe(2);
  });

  it("steps, wraps, and reports impossible moves as -1", () => {
    expect(stepOrdinal(0, 3, 1, false)).toBe(1);
    expect(stepOrdinal(2, 3, 1, true)).toBe(0);
    expect(stepOrdinal(2, 3, 1, false)).toBe(-1);
    expect(stepOrdinal(0, 3, -1, false)).toBe(-1);
    expect(stepOrdinal(0, 3, -1, true)).toBe(2);
  });
});

describe("applyFindLoad", () => {
  function makeEnv() {
    const listeners: Array<(ev: Record<string, unknown>) => void> = [];
    const ctl = { tag: "controller" };
    const sw = {
      controller: ctl,
      addEventListener(_t: string, fn: (ev: Record<string, unknown>) => void) {
        listeners.push(fn);
      },
    };
    const evals: string[] = [];
    const forwarded: unknown[] = [];
    const w: Record<string, unknown> = {
      navigator: { serviceWorker: sw },
      eval: (code: string) => {
        evals.push(code);
        w.__zlFind = (ev: unknown) => forwarded.push(ev);
      },
    };
    applyFindLoad(w);
    const fire = (source: unknown, data: unknown, ports: unknown[] = []) => {
      for (const fn of listeners) fn({ source, data, ports });
    };
    return { w, evals, forwarded, fire, ctl };
  }

  const MSG = { type: "zl:findLoad", cmd: "find", pattern: "x", code: "..." };

  it("evaluates the attached code once and forwards the message", () => {
    const e = makeEnv();
    e.fire(e.ctl, MSG);
    expect(e.evals).toEqual(["..."]);
    expect(e.forwarded.length).toBe(1);
    e.fire(e.ctl, { ...MSG, cmd: "next", code: "..." });
    expect(e.evals.length).toBe(1); // idempotent per document
    expect(e.forwarded.length).toBe(2);
  });

  it("ignores messages not from the controlling worker", () => {
    const e = makeEnv();
    e.fire({ tag: "imposter" }, MSG);
    expect(e.evals.length).toBe(0);
    expect(e.forwarded.length).toBe(0);
  });

  it("ignores other message types", () => {
    const e = makeEnv();
    e.fire(e.ctl, { type: "zl:tabsOp", code: "..." });
    expect(e.evals.length).toBe(0);
  });

  it("registers nothing without a controller", () => {
    let added = 0;
    const w: Record<string, unknown> = {
      navigator: {
        serviceWorker: {
          controller: undefined,
          addEventListener: () => {
            added++;
          },
        },
      },
    };
    applyFindLoad(w);
    expect(added).toBe(0);
  });
});
