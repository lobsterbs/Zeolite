import { describe, expect, it } from "vitest";
import { activeStreams, heartbeatArmed, streamAlive, streamDone } from "../streams-alive";

/* #99: the heartbeat arms while streams pump and stops when the last
   one settles. The ping payload is not under test - only the counter
   and the interval lifecycle. Every test ends with the heartbeat
   disarmed, so no interval outlives the run. */

describe("streams-alive (#99 keepalive)", () => {
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
