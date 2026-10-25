import { expect, it } from "vitest";
import { netLogCursor, netLogPush, netLogSince } from "../netlog";
it("redacts OAuth, CAPTCHA and header secrets before network storage (#443)", () => {
  const start=netLogCursor();
  const original={method:"GET",path:"/cb?code=path-secret",dest:"https://u:password-secret@a.test/?code=code-secret&cf-turnstile-response=captcha-secret&view=mail",status:200,ms:1,bytes:2,rtype:"FETCH",detail:{internalUrl:"/?state=state-secret",ttfb:1,reqHeaders:{Authorization:"header-secret"}}};
  netLogPush(original);
  const json=JSON.stringify(netLogSince(start));
  for(const value of ["path-secret","password-secret","code-secret","captcha-secret","state-secret","header-secret"])expect(json).not.toContain(value);
  expect(json).toContain("view=mail");
  expect(original.detail.reqHeaders.Authorization).toBe("header-secret");
});
