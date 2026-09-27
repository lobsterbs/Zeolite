/* Deterministic session recording (Phase 9, 1.9 Fullerene).

   A recording is a structured, replayable artifact of one engine
   session window: navigations and subresource requests (from the
   network inspector ring), rewrite decisions (from the opt-in tracing
   ring), WebSocket lifecycle/message-direction events (also tracing
   ring entries; payloads are never recorded), and the cookie jar
   shape (names and scopes only - values are secrets and never land in
   a plaintext artifact, unlike the encrypted 1.7 session export).

   The module is pure: the service worker feeds it ring slices at
   zl:recordStop and it normalizes, sorts and redacts them. Replay
   (suite/replay.mjs) re-issues the recorded destination URLs through
   an engine and compares stable facts. Determinism rules: given the
   same ring slices and timestamps, the artifact is byte-identical -
   no random ids, no wall-clock beyond the two recorded timestamps. */

import { redactSecrets } from "./diag";

export interface RecordingState {
  id: string;
  startedAt: number;
  netCursor: number;
  traceCursor: number;
  tracingWasEnabled: boolean;
}

export interface RecordedRequest {
  seq: number;
  method: string;
  /** Upstream destination URL, secret-redacted. */
  dest: string;
  status: number;
  rtype: string;
  bytes: number;
  rewritten?: string;
  transport?: string;
  err?: string;
}

export interface RecordedDecision {
  seq: number;
  subsystem: string;
  rule?: string;
  original: string;
  result: string;
}

export interface RecordedWs {
  seq: number;
  /** open | error | tx | rx (direction only; payloads never recorded). */
  kind: string;
  url: string;
}

export interface RecordedCookie {
  origin: string;
  name: string;
  domain: string;
  path: string;
}

export interface SessionRecord {
  format: "zlRecord";
  version: 1;
  engine: string;
  id: string;
  startedAt: number;
  stoppedAt: number;
  requests: RecordedRequest[];
  decisions: RecordedDecision[];
  websockets: RecordedWs[];
  cookies: RecordedCookie[];
}

/** zl:recordStart. Cursors are the current ring sequence numbers so
    zl:recordStop can slice only the window in between. */
export function beginRecording(opts: {
  id?: unknown;
  now: number;
  netCursor: number;
  traceCursor: number;
  tracingWasEnabled: boolean;
}): RecordingState {
  const id = typeof opts.id === "string" && opts.id ? opts.id.slice(0, 64) : "rec-" + opts.now.toString(36);
  return {
    id,
    startedAt: opts.now,
    netCursor: opts.netCursor,
    traceCursor: opts.traceCursor,
    tracingWasEnabled: opts.tracingWasEnabled,
  };
}

/** zl:recordStop. Builds the artifact from the delta slices the
    service worker passes in. Pure and deterministic. */
export function finishRecording(
  state: RecordingState,
  input: {
    now: number;
    engine: string;
    netEntries: Array<{
      seq: number;
      method: string;
      dest: string;
      status: number;
      rtype: string;
      bytes: number;
      rewritten?: string;
      transport?: string;
      err?: string;
    }>;
    traceEntries: Array<{
      seq: number;
      subsystem: string;
      rule?: string;
      original: string;
      result: string;
    }>;
    cookieJar: Array<[string, Array<{ name: string; domain: string; path: string }>]> | Map<string, Array<{ name: string; domain: string; path: string }>>;
  },
): SessionRecord {
  const requests = input.netEntries
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: e.seq,
      method: e.method,
      dest: redactSecrets(e.dest),
      status: e.status,
      rtype: e.rtype,
      bytes: e.bytes,
      ...(e.rewritten ? { rewritten: e.rewritten } : {}),
      ...(e.transport ? { transport: e.transport } : {}),
      ...(e.err ? { err: e.err } : {}),
    }));

  const decisions = input.traceEntries
    .filter((e) => e.subsystem !== "websocket")
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: e.seq,
      subsystem: e.subsystem,
      ...(e.rule ? { rule: e.rule } : {}),
      original: redactSecrets(e.original),
      result: redactSecrets(e.result),
    }));

  const websockets = input.traceEntries
    .filter((e) => e.subsystem === "websocket")
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((e) => {
      /* The ws bridge traces four shapes: tx/rx (original is the
         direction tag, result the URL), open/error (original is the
         URL, result the tag), upgrade (result is the upgraded URL)
         and abnormal close (result is the reason). Normalize all of
         them to {kind, url}. */
      let kind = e.original;
      let url = e.result;
      if (e.result === "open" || e.result === "error") {
        kind = e.result;
        url = e.original;
      } else if (e.rule === "upgrade") {
        kind = "upgrade";
      } else if (e.result.startsWith("abnormal close")) {
        kind = "close";
        url = e.original;
      }
      return { seq: e.seq, kind, url: redactSecrets(url) };
    });

  const jar = input.cookieJar instanceof Map ? [...input.cookieJar] : input.cookieJar;
  const cookies: RecordedCookie[] = [];
  for (const [origin, entries] of jar) {
    for (const c of entries) cookies.push({ origin, name: c.name, domain: c.domain, path: c.path });
  }

  return {
    format: "zlRecord",
    version: 1,
    engine: input.engine,
    id: state.id,
    startedAt: state.startedAt,
    stoppedAt: input.now,
    requests,
    decisions,
    websockets,
    cookies,
  };
}
