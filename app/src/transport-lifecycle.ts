/* Transport lifecycle state machine (issue #119).

   The vendored wasm transports surface no lifecycle of their own: a
   socket can die and the singleton still presents itself as ready.
   This machine is driven from the seams that DO observe the
   transport - vendored init() (connecting -> connected/dead), the
   wisp socket watcher's open/close events, and reset() (dead) - and
   the request path consults it instead of trusting a
   dead-but-present client. A request that arrives while the
   transport is known-dead waits (bounded) for reconnection instead
   of failing in the sub-second window before the watcher's first
   reconnect attempt.

   Pure surface, unit-gated in __tests__/transport-select.test.ts;
   the wiring points (init/watcher/reset glue in the vendored file,
   the wispFetch wait in transport.ts) are thin and live-verified,
   the same split the #74 reconnect work used. */

import { DIAG } from "./diag";

export type TransportState = "idle" | "connecting" | "connected" | "dead";

type Listener = (state: TransportState) => void;

const listeners = new Set<Listener>();
let state: TransportState = "idle";

/** Current machine state. "idle" means never initialized (not dead). */
export function transportState(): TransportState {
  return state;
}

/** Subscribe to state transitions. Returns an unsubscribe function. */
export function onTransportState(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Transition the machine. Same-state calls are no-ops; every real
    transition reaches DIAG so the degraded-mode story stays visible
    in devtools. A listener must never break the machine. */
export function setTransportState(next: TransportState, reason: string): void {
  if (next === state) return;
  const prev = state;
  state = next;
  DIAG.emit({
    category: "TRANSPORT",
    severity: next === "dead" ? "warning" : "info",
    message: "transport lifecycle: " + prev + " -> " + next + " (" + reason + ")",
  });
  for (const cb of listeners) {
    try {
      cb(next);
    } catch {
      /* listener errors are the listener's problem */
    }
  }
}

/** Bounded wait for the machine to reach `target`. Resolves false on
    timeout; a false answer is never itself an error - the caller
    proceeds on its normal path and fails honestly if the transport
    is really gone. This only removes the sub-second window where a
    known-dead transport fails a request that one reconnect later
    would have served. */
export function waitForTransportState(target: TransportState, timeoutMs: number): Promise<boolean> {
  if (state === target) return Promise.resolve(true);
  return new Promise((resolve) => {
    const off = onTransportState((s) => {
      if (s === target) {
        clearTimeout(t);
        off();
        resolve(true);
      }
    });
    const t = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
  });
}
