import { describe, expect, it } from "vitest";
import {
  afterDispatchError,
  beforeDispatchFailure,
  deliveredResponse,
  deliveryAllowsReplay,
  deliveryStateOf,
  TransportDeliveryError,
} from "../delivery";

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

  it("does not overwrite already classified transport errors", () => {
    const first = beforeDispatchFailure("relay", new Error("no dispatch"));
    expect(afterDispatchError("wisp", first)).toBe(first);
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
