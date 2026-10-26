import { describe, expect, it, vi } from "vitest";
import { activeStreams, heartbeatArmed, streamAlive, streamDone } from "../streams-alive";

/* #99: the heartbeat arms while streams pump and stops when the last
   one settles. The ping payload is not under test - only the counter
   and the interval lifecycle. Every test ends with the heartbeat
   disarmed, so no interval outlives the run. */

describe("streams-alive (#99 keepalive)", () => {
  it("closes both heartbeat ports only after the last stream and recreates them next time", () => {
    const channels: Array<{ port1: { onmessage: unknown; close: ReturnType<typeof vi.fn> }; port2: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }> = [];
    class Channel {
      port1 = { onmessage: null as unknown, close: vi.fn() };
      port2 = { postMessage: vi.fn(), close: vi.fn() };
      constructor() { channels.push(this); }
    }
    vi.stubGlobal("MessageChannel", Channel);
    try {
      streamAlive(); streamAlive();
      expect(channels).toHaveLength(1);
      streamDone();
      expect(channels[0].port1.close).not.toHaveBeenCalled();
      streamDone();
      expect(channels[0].port1.close).toHaveBeenCalledOnce();
      expect(channels[0].port2.close).toHaveBeenCalledOnce();
      streamAlive(); streamDone();
      expect(channels).toHaveLength(2);
      expect(channels[1].port1.close).toHaveBeenCalledOnce();
      expect(channels[1].port2.close).toHaveBeenCalledOnce();
    } finally {
      while (activeStreams()) streamDone();
      vi.unstubAllGlobals();
    }
  });

  it("counts active streams and floors at zero on unbalanced done calls", () => {
    expect(activeStreams()).toBe(0);
    streamAlive();
    streamAlive();
    expect(activeStreams()).toBe(2);
    streamDone();
    streamDone();
    streamDone();
    expect(activeStreams()).toBe(0);
  });

  it("keeps host-scoped loading separate while preserving global keepalive", () => {
    streamAlive("https://site-a.example/page");
    streamAlive("https://site-b.example/styles.css");
    streamAlive("https://site-a.example/assets/app.js");
    try {
      expect(activeStreams()).toBe(3);
      expect(activeStreams("site-a.example")).toBe(2);
      expect(activeStreams("site-b.example")).toBe(1);
      expect(activeStreams("site-c.example")).toBe(0);
      streamDone("https://site-a.example/page");
      expect(activeStreams("site-a.example")).toBe(1);
      streamDone("https://site-b.example/styles.css");
      expect(activeStreams("site-b.example")).toBe(0);
      expect(activeStreams("site-a.example")).toBe(1);
    } finally {
      streamDone("https://site-a.example/assets/app.js");
      while (activeStreams()) streamDone();
    }
    expect(activeStreams()).toBe(0);
  });

  it("arms the heartbeat while active and stops it when the last stream settles", () => {
    expect(heartbeatArmed()).toBe(false);
    streamAlive();
    expect(heartbeatArmed()).toBe(true);
    streamAlive();
    streamDone();
    expect(heartbeatArmed()).toBe(true);
    streamDone();
    expect(heartbeatArmed()).toBe(false);
  });
});
