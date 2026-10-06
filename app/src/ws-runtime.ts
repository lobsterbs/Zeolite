/* WebSocket bridge runtime (issue #88: modularize sw.ts - extract the
   WebSocket handling): the one bridge instance and its wiring to the
   libcurl transport (TLS terminates there) live here instead of sw.ts.
   The bridge class itself is ./wsbridge (unit-gated); this module is
   the production wiring: openWebSocket as the factory, netlog rows for
   the open (status 101) and the final close (code + byte totals),
   DIAG events for abnormal closes, and the tracing hook.

   Pages route ws(s):// through the zl:wsOpen control message; ws:// is
   upgraded to wss:// before the transport sees it. The zl:wsOpen
   handler (sender verification, virtual-origin identity) stays with
   the control plane; it calls wsBridge.open(). */

import { DIAG } from "./diag";
import { netLog, netLogPush, type NetEntry } from "./netlog";
import { openWebSocket } from "./transport";
import { traceDecision } from "./tracing";
import { WsBridge } from "./wsbridge";

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
  {
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
        transport: "NativeTransit",
        detail: { internalUrl: "(wisp stream)", ttfb: ms },
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
        transport: "NativeTransit",
        detail: { internalUrl: "(wisp stream)", ttfb: ms },
      });
    },
    trace: (d) => void traceDecision(d),
  },
);
