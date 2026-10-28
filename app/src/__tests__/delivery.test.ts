import { describe, expect, it } from "vitest";
import {
  afterDispatchError,
  beforeDispatchFailure,
  deliveredResponse,
  deliveryAllowsReplay,
  deliveryStateOf,
  TransportDeliveryError,
  attemptDelivery, deliveryFailure, deliveryResponse, deliveryState, prepareDelivery,
} from "../delivery";

import { canReplayAfterFailure } from "../transport";

describe("explicit request delivery outcomes (#454)", () => {
  it("records the only proven pre-dispatch case from a call-site boundary", () => {
    const initFailure = beforeDispatchFailure("wisp", new Error("transport initialization refused"));
    expect(initFailure).toBeInstanceOf(TransportDeliveryError);
    expect(initFailure.deliveryState).toBe("definitely-not-delivered");
    expect(initFailure.transport).toBe("wisp");
    expect(deliveryStateOf(initFailure)).toBe("definitely-not-delivered");
  });

  it("makes response receipt an explicit delivered-response outcome", () => {
    const response = new Response("ok", { status: 201 });
    const outcome = deliveredResponse("relay", response);
    expect(outcome.state).toBe("delivered-response");
    expect(outcome.transport).toBe("relay");
    if (outcome.state === "delivered-response") expect(outcome.response).toBe(response);
  });

  it("never treats exception text as proof of non-delivery after dispatch", () => {
    for (const msg of [
      "websocket did not open",
      "connection reset before headers",
      "transport closed",
      "failed sending data",
    ]) {
      const e = afterDispatchError("wisp-route", new Error(msg));
      expect(e.deliveryState).toBe("delivery-unknown");
      expect(e.transport).toBe("wisp-route");
      expect(e.message).toBe(msg);
    }
    expect(deliveryStateOf(new Error("definitely not delivered"))).toBe("delivery-unknown");
  });

  it("overrides stale pre-dispatch claims after an adapter is called", () => {
    const first = beforeDispatchFailure("relay", new Error("no dispatch"));
    expect(deliveryStateOf(afterDispatchError("wisp", first))).toBe("delivery-unknown");
  });

  it("only replays unknown results for idempotent methods; never replays a response", () => {
    expect(deliveryAllowsReplay("delivery-unknown", false)).toBe(false);
    expect(deliveryAllowsReplay("delivery-unknown", true)).toBe(true);
    expect(deliveryAllowsReplay("definitely-not-delivered", false)).toBe(true);
    expect(deliveryAllowsReplay("delivered-response", true)).toBe(false);
    expect(deliveryAllowsReplay("delivered-response", false)).toBe(false);
  });

  it("keeps untrusted cause text out of the state and transport fields", () => {
    const err = afterDispatchError("relay", new Error("request?access_token=secret"));
    expect(err.deliveryState).toBe("delivery-unknown");
    expect(err.transport).toBe("relay");
    expect(Object.keys(err)).toContain("deliveryState");
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("delivery evidence (#454)", () => {
  it("records initialization failures before target dispatch and retains their cause", async () => {
    const error = new Error("init failed");
    const failure = await prepareDelivery("wisp", async () => { throw error; }).catch(e => e);
    expect(failure.cause).toBe(error);
    expect(deliveryState(failure)).toBe("definitely-not-delivered");
    expect(canReplayAfterFailure({ method: "POST", body: "x" }, failure)).toBe(true);
  });
  it.each(["before response", "after body dispatch", "after upstream acceptance"])("keeps %s failure ambiguous once the adapter was called", async message => {
    const error = new Error(message);
    const result = await attemptDelivery("wisp-route", async () => { throw error; });
    expect(result.state).toBe("delivery-unknown");
    expect(result.state !== "delivered-response" && (result.cause as TransportDeliveryError).cause).toBe(error);
    expect(() => deliveryResponse(result)).toThrow(message);
    expect(canReplayAfterFailure({ method: "POST", body: "x" }, error)).toBe(false);
    expect(canReplayAfterFailure({ method: "GET" }, error)).toBe(true);
  });
  it("returns response evidence without consuming the body", async () => {
    const response = new Response("data");
    const result = await attemptDelivery("relay", async () => response);
    expect(result.state).toBe("delivered-response");
    expect(deliveryResponse(result)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
  it("ignores forged fields and suggestive transport messages", () => {
    const error = Object.assign(new Error("websocket did not open"), { delivery: "definitely-not-delivered" });
    expect(deliveryState(error)).toBe("delivery-unknown");
    expect(canReplayAfterFailure({ method: "POST", body: "x" }, error)).toBe(false);
  });
  it("never replays caller aborts or one-shot bodies even with pre-dispatch evidence", () => {
    const error = new DOMException("aborted", "AbortError");
    deliveryFailure("wisp", error, "definitely-not-delivered");
    expect(canReplayAfterFailure({ method: "POST", body: "x" }, error)).toBe(false);
    expect(canReplayAfterFailure({ method: "GET", body: new ReadableStream() }, new Error())).toBe(false);
  });
  it("correlates sanitized evidence without exposing causes or mixing clients", async () => {
    const { DIAG } = await import("../diag");
    const start = DIAG.snapshot(0).lastSeq;
    const a = DIAG.trace("delivery-client-a"); const b = DIAG.trace("delivery-client-b");
    const error = new Error("private-body-and-credential-value");
    await attemptDelivery("wisp", async () => { throw error; }, a);
    await attemptDelivery("wisp-route", async () => new Response("private-response"), b);
    const own = DIAG.snapshot(start, "delivery-client-a").events;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      deliveryState: "delivery-unknown",
      deliveryTransport: "wisp",
    });
    expect(own[0].message).toContain("delivery-unknown; transport=wisp");
    expect(JSON.stringify(own)).not.toContain("wisp-route");
    expect(JSON.stringify(DIAG.snapshot(start))).not.toContain("private-body-and-credential-value");
    expect(JSON.stringify(DIAG.snapshot(start))).not.toContain("private-response");
  });

  it("records pre-dispatch and delivered-response certainty as structured evidence", async () => {
    const { DIAG } = await import("../diag");
    const start = DIAG.snapshot(0).lastSeq;
    const pre = DIAG.trace("delivery-pre-client");
    const ok = DIAG.trace("delivery-ok-client");
    await prepareDelivery("wisp", async () => { throw new Error("AUTH_CANARY"); }, pre).catch(() => {});
    await attemptDelivery("relay", async () => new Response("PRIVATE_BODY"), ok);
    const preEvents = DIAG.snapshot(start, "delivery-pre-client").events;
    const okEvents = DIAG.snapshot(start, "delivery-ok-client").events;
    expect(preEvents.at(-1)).toMatchObject({
      deliveryState: "definitely-not-delivered",
      deliveryTransport: "wisp",
      stage: "UPSTREAM_REQUEST",
    });
    expect(okEvents.at(-1)).toMatchObject({
      deliveryState: "delivered-response",
      deliveryTransport: "relay",
      stage: "UPSTREAM_RESPONSE",
    });
    const exported = JSON.stringify({ preEvents, okEvents });
    expect(exported).not.toContain("AUTH_CANARY");
    expect(exported).not.toContain("PRIVATE_BODY");
  });

  it("does not trust mutable public state fields for retry decisions", () => {
    const error = afterDispatchError("wisp", new Error("accepted then lost"));
    Object.assign(error, { deliveryState: "definitely-not-delivered" });
    expect(deliveryStateOf(error)).toBe("delivery-unknown");
    expect(canReplayAfterFailure({ method: "POST", body: "x" }, error)).toBe(false);
  });

});
