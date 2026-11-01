import { describe, expect, it, beforeEach } from "vitest";
import { recordScriptUrl, recoverFlagSurgeryScript, resetAssetBases } from "../assetbases";

const TOKEN_A = "Afv31r0ruEftvxJMTKOfNJ2ST8bhMH9Qnd3lVcyPNJa1tlQfpAMQcw";
const TOKEN_B = "Bfv31r0ruEftvxJMTKOfNJ2ST8bhMH9Qnd3lVcyPNJa1tlQfpAMQcw";
const observed = "https://www.google.com/" + TOKEN_A +
  "/_/mss/search-next/_/js/k=search-next.aim.en_US.DrEvmsWGmck.2019.O/ck=search-next.aim.gHrEy2CO0Sc.L.B1.O/exm=AIvLTe/ed=1/cb=loaded_g_0/m=oldModule";
const target = "https://www.google.com/" + TOKEN_B +
  "/_/mss/search-next/_/js/k=search-next.aim.en_US.DrEvmsWGmck.2019.O/ck=search-next.aim.gHrEy2CO0Sc.L.B1.O/exm=Q2wZ/ed=1/cb=loaded_g_0/m=newModule?hl=en";

const js = () => new Response("window.moduleLoaded=true;", {
  status: 200,
  headers: { "content-type": "application/javascript" },
});

describe("Google AI Mode mss module recovery", () => {
  beforeEach(() => resetAssetBases());

  it("reuses only the observed token base for the same mss app namespace", async () => {
    recordScriptUrl("https://www.google.com/search?q=ai", observed);
    const seen: string[] = [];
    const rec = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=ai",
      target,
      new Headers(),
      async (url) => { seen.push(url); return js(); },
      "mss-recovery",
    );

    expect(rec?.url).toBe(
      "https://www.google.com/" + TOKEN_A +
      "/_/mss/search-next/_/js/k=search-next.aim.en_US.DrEvmsWGmck.2019.O/ck=search-next.aim.gHrEy2CO0Sc.L.B1.O/exm=Q2wZ/ed=1/cb=loaded_g_0/m=newModule?hl=en",
    );
    expect(seen).toEqual([rec?.url]);
    expect(rec?.url).not.toContain(TOKEN_B);
  });

  it("deduplicates loader retries but still tries a different module URL", async () => {
    recordScriptUrl("https://www.google.com/search?q=ai", observed);
    const firstSeen: string[] = [];
    const first = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=ai",
      target,
      new Headers(),
      async (url) => { firstSeen.push(url); return new Response("missing", { status: 404 }); },
    );
    expect(first).toBeNull();
    expect(firstSeen).toHaveLength(1);

    const duplicate = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=ai",
      target,
      new Headers(),
      async (url) => { throw new Error("duplicate target should not fetch: " + url); },
    );
    expect(duplicate).toBeNull();

    const secondTarget = target.replace("m=newModule", "m=anotherModule");
    const secondSeen: string[] = [];
    const second = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=ai",
      secondTarget,
      new Headers(),
      async (url) => { secondSeen.push(url); return js(); },
    );
    expect(second?.url).toContain("/m=anotherModule?hl=en");
    expect(secondSeen).toHaveLength(1);
  });

  it("does not reuse a base from another app namespace or origin", async () => {
    recordScriptUrl("https://www.google.com/search?q=ai", observed);
    const otherApp = target.replace("/mss/search-next/", "/mss/search/");
    const rec = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=ai",
      otherApp,
      new Headers(),
      async () => { throw new Error("mismatched app must not fetch"); },
    );
    expect(rec).toBeNull();
  });
});
