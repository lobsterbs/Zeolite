/// <reference lib="webworker" />
/* SW keepalive for pumping rewrite streams (#99). A service worker
   is terminated after ~30s without event dispatch; a long HTML/CSS
   body pumping inside ReadableStream start() dispatches no events
   (the fetch event long settled), so the worker dies mid-stream:
   the document freezes in loading and the control plane stops
   answering until the browser restarts it. While any stream is
   active, a MessageChannel self-ping every 15s dispatches a message
   event and resets the idle timer. A never-settling waitUntil would
   pin the worker forever and block updates, so the ping stops when
   the last stream settles. */
let active = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeat !== null) return;
  const ch = new MessageChannel();
  /* The dispatched message event is what resets the idle timer; the
     no-op listener keeps the port served. */
  ch.port1.onmessage = () => undefined;
  const ping = () => {
    try {
      ch.port2.postMessage(0);
    } catch {
      /* a closed port cannot ping; the next stream re-arms */
    }
  };
  ping();
  heartbeat = setInterval(ping, 15_000);
}

/** A rewrite stream started pumping: arm the heartbeat. */
export function streamAlive(): void {
  active++;
  startHeartbeat();
}

/** A rewrite stream settled (closed or errored): stop the heartbeat
    once the last one is gone. Paired with streamAlive in a finally,
    so every exit path lands here; the counter floors at zero instead
    of going negative on an unbalanced call. */
export function streamDone(): void {
  active = Math.max(0, active - 1);
  if (active === 0 && heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/** Streams currently pumping (test seam). */
export function activeStreams(): number {
  return active;
}

/** True while the heartbeat interval is armed (test seam). */
export function heartbeatArmed(): boolean {
  return heartbeat !== null;
}
