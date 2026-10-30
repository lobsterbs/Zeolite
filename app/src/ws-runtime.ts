/* WebSocket bridge runtime (issue #88: modularize sw.ts - extract the
   WebSocket handling): the bridge instances and their wiring to the
   transports live here instead of sw.ts. The bridge class itself is
   ./wsbridge (unit-gated); this module is the production wiring:
   openWebSocket as the wisp factory (TLS terminates there), netlog
   rows for the open (status 101) and the final close (code + byte
   totals), DIAG events for abnormal closes, and the tracing hook.

   Pages route ws(s):// through the zl:wsOpen control message; ws:// is
   upgraded to wss:// before a transport sees it. #511 adds the second
   factory: when the embedder registered a relay channel, the control
   plane opens page WebSockets on the relay bridge (embedder-side
   egress) instead of the wisp transport; both share this accounting
   shape, only the transport label and the internal route note differ.
   The zl:wsOpen handler (sender verification, virtual-origin
   identity) stays with the control plane; it calls one of the two. */

import { DIAG } from "./diag";
import { netLog, netLogPush, type NetEntry } from "./netlog";
import { openWebSocket } from "./transport";
import { relayWsFactory } from "./ws-relay";
import { traceDecision } from "./tracing";
import { WsBridge, type WsHooks } from "./wsbridge";

function bridgeHooks(transport: "NativeTransit" | "Relay", internalUrl: string): WsHooks {
  return {
    attempt: (url, upgraded) => ({
      url,
      upgraded,
      entry: null as NetEntry | null,
      bytes: 0,
      traceId: DIAG.trace(),
    }),
    onReady: (token, protocol, ms) => {
      const t = token as { url: string; entry: NetEntry | null; traceId: string };
      netLogPush({
        method: "WS",
        traceId: t.traceId,
        path: "(ws bridge)",
        dest: t.url,
        status: 101,
        ms,
        bytes: 0,
        verdict: "ws" + (protocol ? " proto " + protocol : ""),
        rtype: "WEBSOCKET",
        transport,
        detail: { internalUrl, ttfb: ms },
      });
      t.entry = netLog[netLog.length - 1];
    },
    onBytes: (token, rx, tx) => {
      const t = token as { entry: NetEntry | null; bytes: number };
      t.bytes += rx + tx;
      if (t.entry) t.entry.bytes = t.bytes;
    },
    onClose: (token, code, clean, ms) => {
      const t = token as { url: string; bytes: number; traceId: string };
      if (!clean) {
        DIAG.emit({
          category: "WEBSOCKET",
          cause: "failure",
          severity: "error",
          message: "websocket closed abnormally",
          technicalReason: "close code " + code,
          url: t.url,
          traceId: t.traceId,
          requestId: t.traceId,
        });
      }
      netLogPush({
        method: "WS",
        traceId: t.traceId,
        path: "(ws bridge)",
        dest: t.url,
        status: code,
        ms,
        bytes: t.bytes,
        verdict: clean ? "ws:closed" : "ws:aborted",
        err: clean ? undefined : "abnormal close " + code,
        rtype: "WEBSOCKET",
        transport,
        detail: { internalUrl, ttfb: ms },
      });
    },
    trace: (d) => void traceDecision(d),
  };
}

export const wsBridge = new WsBridge(
  {
    open: (url, protocols, h, headers) =>
      openWebSocket(
        url,
        protocols,
        {
          onopen: (p) => h.onopen(p),
          onmessage: (d) => h.onmessage(d),
          onclose: (c, r) => h.onclose(c, r),
          onerror: (e) => h.onerror(e),
        },
        headers,
      ),
  },
  bridgeHooks("NativeTransit", "(wisp stream)"),
);

/* #511: the relay bridge shares the class and the accounting; only the
   factory and the transport label differ. */
export const wsRelayBridge = new WsBridge(relayWsFactory, bridgeHooks("Relay", "(relay ws)"));
