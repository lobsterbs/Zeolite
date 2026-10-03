import { describe, expect, it } from "vitest";
import { isPassChallenge } from "../cookies";

/* Issue #52: detect-only recognition of the Anubis pass-challenge
   endpoint. The engine never solves challenges; this is the seam that
   lets the SW flag a solved challenge handing cookies back. */
describe("isPassChallenge (#52)", () => {
  it("recognizes the pass-challenge endpoint on any host", () => {
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge")).toBe(true);
    expect(isPassChallenge("http://host.example/.within.website/x/cmd/anubis/api/pass-challenge?redir=%2F")).toBe(true);
    expect(isPassChallenge("https://anubis.example/.within.website/x/cmd/anubis/api/pass-challenge#")).toBe(true);
  });

  it("rejects lookalikes and extra path segments", () => {
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge/extra")).toBe(false);
    expect(isPassChallenge("https://startpage.com/x/cmd/anubis/api/pass-challenge")).toBe(false);
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge-other")).toBe(false);
    expect(isPassChallenge("https://startpage.com/")).toBe(false);
  });

  it("handles non-URLs honestly", () => {
    expect(isPassChallenge("")).toBe(false);
    expect(isPassChallenge("not a url")).toBe(false);
  });
});
