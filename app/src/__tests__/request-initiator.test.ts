import { describe, expect, it } from "vitest";
import { extensionRequestHeaders, requestInitiator } from "../request";

function request(init: {
  headers?: HeadersInit;
  mode?: RequestMode;
  destination?: string;
} = {}): Request {
  return {
    headers: new Headers(init.headers),
    mode: init.mode ?? "cors",
    destination: init.destination ?? "",
  } as unknown as Request;
}

describe("request initiator attribution (#545)", () => {
  it("uses only the bounded page/worker instrumentation vocabulary", () => {
    expect(requestInitiator(request({ headers: { "x-zl-init": "fetch" } }))).toBe("FETCH");
    expect(requestInitiator(request({ headers: { "x-zl-initiator": "xhr" } }))).toBe("XHR");
    expect(requestInitiator(request({ headers: { "x-zl-initiator": "send-beacon" } }))).toBe("SEND_BEACON");
    expect(requestInitiator(request({ headers: { "x-zl-initiator": "worker-fetch" } }))).toBe("WORKER_FETCH");
  });

  it("classifies browser evidence without guessing empty-destination requests", () => {
    expect(requestInitiator(request({ mode: "navigate" }))).toBe("NAVIGATION");
    expect(requestInitiator(request({ headers: { accept: "text/event-stream" } }))).toBe("EVENTSOURCE");
    expect(requestInitiator(request({ destination: "image" }))).toBe("RESOURCE");
    expect(requestInitiator(request())).toBe("UNKNOWN");
    expect(requestInitiator(request({ headers: { "x-zl-initiator": "spoofed" } }))).toBe("UNKNOWN");
  });
});

describe("extension request-header projection (#545)", () => {
  it("does not expose the internal initiator marker to extension APIs", () => {
    const out = extensionRequestHeaders(new Headers({
      "x-zl-initiator": "xhr",
      "x-extension-visible": "normal",
    }));
    expect(out["x-zl-initiator"]).toBeUndefined();
    expect(out["x-extension-visible"]).toBe("normal");
  });
});
