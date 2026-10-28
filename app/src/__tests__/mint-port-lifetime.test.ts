import { afterEach, describe, expect, it, vi } from "vitest";
import { mintRoute } from "../bootstrap/mint";
import { mintUrlViaRelay } from "../worker-prelude";

type ReplyPort = { postMessage(data: unknown): void; close: ReturnType<typeof vi.fn> };

function stubChannels() {
  const channels: Array<{ port1: { close: ReturnType<typeof vi.fn> }; port2: ReplyPort }> = [];
  class Channel {
    port1 = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: vi.fn(),
    };
    port2 = {
      postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      close: vi.fn(),
    };
    constructor() { channels.push(this); }
  }
  vi.stubGlobal("MessageChannel", Channel);
  return channels;
}

afterEach(() => vi.unstubAllGlobals());

describe("route mint channel lifetime", () => {
  it("closes both ends after successful page and worker replies", async () => {
    const channels = stubChannels();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage(_message: unknown, ports: MessagePort[]) {
            (ports[0] as unknown as ReplyPort).postMessage({ ok: true, route: "/j/page" });
          },
        },
      },
    });

    expect(await mintRoute("https://ports.example/page-closed")).toBe("/j/page");
    expect(await mintUrlViaRelay((_message, ports) => {
      (ports?.[0] as unknown as ReplyPort).postMessage({ ok: true, route: "/j/worker" });
      return true;
    }, "https://ports.example/worker-closed")).toBe("/j/worker");

    expect(channels).toHaveLength(2);
    for (const channel of channels) {
      expect(channel.port1.close).toHaveBeenCalledOnce();
      expect(channel.port2.close).toHaveBeenCalledOnce();
    }
  });

  it("releases ports on page send failure and worker timeout", async () => {
    const channels = stubChannels();
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: { postMessage() { throw new Error("send failed"); } } },
    });

    expect(await mintRoute("https://ports.example/page-send-failed")).toBeNull();
    expect(await mintUrlViaRelay(() => true, "https://ports.example/worker-silent", 20)).toBeNull();

    expect(channels).toHaveLength(2);
    for (const channel of channels) {
      expect(channel.port1.close).toHaveBeenCalledOnce();
      expect(channel.port2.close).toHaveBeenCalledOnce();
    }
  });
});
