import { describe, expect, it, vi } from "vitest";
import { controlQuery } from "../bootstrap/controlquery";

class FakePort {
  peer: FakePort | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(data: unknown): void { this.peer?.onmessage?.({ data }); }
  close(): void { this.closed = true; }
}
class FakeChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

describe("controlQuery worker acquisition", () => {
  it("uses the active worker when the page has not become controlled yet", async () => {
    vi.stubGlobal("MessageChannel", FakeChannel);
    let sent: unknown;
    const active = {
      postMessage(message: unknown, ports: FakePort[]) {
        sent = message;
        ports[0].postMessage({ ok: true, source: "active" });
      },
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: null,
        ready: Promise.resolve({ active }),
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const reply = await new Promise((resolve) => controlQuery({ type: "probe" }, resolve, 1000));
    expect(sent).toEqual({ type: "probe" });
    expect(reply).toEqual({ ok: true, source: "active" });
    vi.unstubAllGlobals();
  });
});
