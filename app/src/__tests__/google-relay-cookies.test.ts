import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayFetch, relayRegister } from "../relayfetch";
import { applySetCookie, cookieHeaderFor, cookiesResetForTests, jarHeaders } from "../cookies";

/* #633 seam (d) regression: the relay chain must carry Set-Cookie into
   the jar and the jar must attach it to the sign-in RPCs. The relay
   response's set-cookie rides the rawHeaders view (Response construction
   drops the forbidden header name, #10); jarHeaders rebuilds a readable
   Headers; applySetCookie admits; cookieHeaderFor attaches on the next
   request. The batchexecute POST and /restart are exactly the requests
   Google answered 400 in the field capture - if this pipeline dropped
   them the flow goes upstream cookieless. */

class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  deliver(m: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}

const ACCTS = "https://accounts.google.com/v3/signin/identifier?dsh=S-1:2&flowName=GlifWebSignIn&flowEntry=ServiceLogin&passive=true";

beforeEach(() => {
  cookiesResetForTests();
});

async function relayedServiceLogin(p: FakePort): Promise<Response> {
  const respP = relayFetch(ACCTS, { method: "GET", headers: new Headers() }, "t-cookie");
  const sent = p.posted[0] as { rid: number; dest: string };
  expect(sent.dest).toBe(ACCTS);
  p.deliver({
    type: "zl:relayHead",
    rid: sent.rid,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/html"]],
    setCookies: [
      "SID=g.a000xyz; Domain=accounts.google.com; Path=/; Secure; HttpOnly",
      "__Secure-OSID=osid123; Domain=.google.com; Path=/; Secure; HttpOnly; SameSite=None",
      "HSID=hsid456; Domain=.google.com; Path=/; Secure",
    ],
  });
  p.deliver({ type: "zl:relayChunk", rid: sent.rid, bytes: new TextEncoder().encode("<html>") });
  p.deliver({ type: "zl:relayEnd", rid: sent.rid });
  const resp = await respP;
  expect(resp).not.toBeNull();
  return resp!;
}

describe("relay Set-Cookie -> jar -> Cookie header (#633 seam d)", () => {
  it("admits relayed Set-Cookie into the jar and attaches them to batchexecute and /restart", async () => {
    const p = new FakePort();
    relayRegister(p as unknown as MessagePort);
    const resp = await relayedServiceLogin(p);

    /* the rawHeaders view is what the jar reads (#10) */
    const raw = (resp as unknown as { rawHeaders?: Array<[string, string]> }).rawHeaders ?? [];
    const sc = raw.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
    expect(sc).toHaveLength(3);

    /* the SW admission seam: applySetCookie(dest, jarHeaders(resp)) */
    const admitted = applySetCookie(ACCTS, jarHeaders(resp));
    expect(admitted.filter((r) => r.stored).map((r) => r.name).sort()).toEqual(
      ["HSID", "SID", "__Secure-OSID"],
    );

    /* the attach seam on the exact requests Google 400ed: the
       identifier batchexecute POST and /restart */
    const rpc = cookieHeaderFor("https://accounts.google.com/batchexecute?rpcids=MI613e", {
      initiator: ACCTS,
    });
    expect(rpc).toContain("SID=g.a000xyz");
    expect(rpc).toContain("__Secure-OSID=osid123");
    expect(rpc).toContain("HSID=hsid456");
    const restart = cookieHeaderFor(
      "https://accounts.google.com/restart?continue=https%3A%2F%2Fwww.google.com%2F&hl=en",
      { initiator: ACCTS },
    );
    expect(restart).toContain("SID=g.a000xyz");

    /* domain scoping stays honest: .google.com cookies ride
       www.google.com, the host-only SID does not */
    const www = cookieHeaderFor("https://www.google.com/", { initiator: ACCTS });
    expect(www).toContain("__Secure-OSID=osid123");
    expect(www).not.toContain("SID=g.a000xyz");
    expect(cookieHeaderFor("https://evil.example/", { initiator: ACCTS })).toBeNull();
  });

  it("a 400 from the relayed batchexecute still admits its Set-Cookie (error-path admission)", async () => {
    const p = new FakePort();
    relayRegister(p as unknown as MessagePort);
    const respP = relayFetch("https://accounts.google.com/batchexecute?rpcids=MI613e", {
      method: "POST",
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
      body: "f.req=1",
    }, "t-400");
    const sent = p.posted[0] as { rid: number };
    p.deliver({
      type: "zl:relayHead",
      rid: sent.rid,
      status: 400,
      statusText: "Bad Request",
      headers: [["content-type", "text/html"]],
      setCookies: ["__Secure-3PSID=psid789; Domain=.google.com; Path=/; Secure; HttpOnly"],
    });
    p.deliver({ type: "zl:relayEnd", rid: sent.rid });
    const resp = await respP;
    expect(resp!.status).toBe(400);
    const admitted = applySetCookie(
      "https://accounts.google.com/batchexecute?rpcids=MI613e",
      jarHeaders(resp!),
    );
    expect(admitted.some((r) => r.stored && r.name === "__Secure-3PSID")).toBe(true);
  });
});
