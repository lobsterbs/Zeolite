/* Zeolite DevTools page: network inspector + per-request detail view +
   opt-in rewrite tracing + diagnostics feed (1.2 Halide). This page is
   served by the engine origin, so it is controlled by the same SW and
   can postMessage it. Polls zl:getNetLog, zl:getDiag and zl:getTracing
   once per second. */

interface NetDetail {
  internalUrl: string;
  ttfb: number;
  initiator?: string;
  reqHeaders?: Record<string, string>;
  respHeaders?: Record<string, string>;
  cookies?: string[];
}

interface NetEntry {
  seq: number;
  ts: number;
  method: string;
  path: string;
  dest: string;
  status: number;
  ms: number;
  bytes: number;
  verdict?: string;
  err?: string;
  transport?: string;
  fallbackReason?: string;
  finalDest?: string;
  detail?: NetDetail;
}

interface DiagEvent {
  seq: number;
  ts: number;
  category: string;
  severity: string;
  message: string;
  stage?: string;
  url?: string;
}

interface TraceEntry {
  seq: number;
  ts: number;
  subsystem: string;
  rule?: string;
  original: string;
  result: string;
  resource?: string;
  traceId?: string;
}

const rows = document.getElementById("rows")!;
const paused = document.getElementById("paused")!;
const statsEl = document.getElementById("stats")!;
const detailEl = document.getElementById("detail")!;
const traceRows = document.getElementById("traceRows")!;
const traceToggle = document.getElementById("traceToggle") as HTMLInputElement;
const diagRows = document.getElementById("diagRows")!;

let entries: NetEntry[] = [];
let lastSeq = 0;
let lastGeneration = -1;
let sortKey: keyof NetEntry = "seq";
let sortDesc = false;
let diagLast = 0;
let diagEvents: DiagEvent[] = [];
let traceLast = 0;
let traceEntries: TraceEntry[] = [];

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function fmtBytes(n: number): string {
  if (n < 0) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  return (n / 1024 / 1024).toFixed(1) + " MiB";
}

/** Per-request detail view (1.2 Halide): everything the SW recorded. */
function showDetail(e: NetEntry): void {
  const d = e.detail;
  const lines: string[] = [
    "target: " + e.dest,
    "internal: " + (d?.internalUrl ?? e.path),
  ];
  if (e.finalDest) lines.push("final destination: " + e.finalDest);
  lines.push(e.method + " -> " + e.status + "  ttfb " + (d?.ttfb ?? e.ms) + " ms, total " + e.ms + " ms");
  if (d?.initiator) lines.push("initiator: " + d.initiator);
  lines.push("transport: " + (e.transport ?? "") + (e.fallbackReason ? " (" + e.fallbackReason + ")" : ""));
  if (e.verdict) lines.push("verdict: " + e.verdict);
  if (e.err) lines.push("error: " + e.err);
  if (d?.cookies?.length) lines.push("set-cookie: " + d.cookies.join(", "));
  if (d?.reqHeaders) {
    lines.push("request headers:");
    for (const [k, v] of Object.entries(d.reqHeaders)) lines.push("  " + k + ": " + v);
  }
  if (d?.respHeaders) {
    lines.push("response headers:");
    for (const [k, v] of Object.entries(d.respHeaders)) lines.push("  " + k + ": " + v);
  }
  detailEl.textContent = lines.join("\n");
}

function render(): void {
  const sorted = [...entries].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
    return sortDesc ? -cmp : cmp;
  });
  rows.replaceChildren(
    ...sorted.map((e) => {
      const tr = document.createElement("tr");
      tr.className = "net";
      tr.addEventListener("click", () => showDetail(e));
      const cells = [
        fmtTime(e.ts),
        e.method,
        e.dest,
        String(e.status),
        String(e.ms),
        fmtBytes(e.bytes ?? -1),
        e.verdict ?? "",
        e.transport ?? "",
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i === 2 && e.err) {
          td.className = "err";
          td.title = e.err;
          td.textContent = e.dest + " (error)";
        } else if (i === 2 && e.finalDest) {
          td.title = "final destination: " + e.finalDest;
        } else if (i === 7 && e.transport === "RewriteFallback") {
          td.className = "fb";
          if (e.fallbackReason) td.title = e.fallbackReason;
        } else if (i === 3 && e.status >= 200) {
          td.className = `status-${Math.floor(e.status / 100)}`;
        }
        tr.appendChild(td);
      });
      return tr;
    }),
  );
}

function renderTrace(): void {
  traceRows.replaceChildren(
    ...[...traceEntries].reverse().map((t) => {
      const tr = document.createElement("tr");
      for (const c of [fmtTime(t.ts), t.subsystem, t.rule ?? "", t.original, t.result, t.resource ?? ""]) {
        const td = document.createElement("td");
        td.textContent = c;
        if (c.length > 120) td.title = c;
        tr.appendChild(td);
      }
      return tr;
    }),
  );
}

function renderDiag(): void {
  diagRows.replaceChildren(
    ...[...diagEvents].reverse().map((d) => {
      const tr = document.createElement("tr");
      const td = (text: string, cls?: string) => {
        const el = document.createElement("td");
        el.textContent = text;
        if (cls) el.className = cls;
        if (text.length > 160) el.title = text;
        tr.appendChild(el);
      };
      td(fmtTime(d.ts));
      td(d.severity, d.severity === "error" || d.severity === "critical" ? "diag-" + d.severity : d.severity === "warning" ? "diag-warning" : undefined);
      td(d.category);
      td(d.stage ?? "");
      td(d.message);
      td(d.url ?? "");
      return tr;
    }),
  );
}

// Column header sorting.
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = (th as HTMLElement).dataset.sort as keyof NetEntry;
    if (key === sortKey) sortDesc = !sortDesc;
    else {
      sortKey = key;
      sortDesc = false;
    }
    render();
  });
});

// Tracing toggle: tell the SW, keep polling for the real state.
traceToggle.addEventListener("change", () => {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return;
  const ch = new MessageChannel();
  ch.port1.onmessage = () => undefined;
  ctl.postMessage({ type: "zl:tracing", enabled: traceToggle.checked }, [ch.port2]);
});

function post(msg: unknown, onReply: (data: any) => void): boolean {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return false;
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => onReply(ev.data);
  ctl.postMessage(msg, [ch.port2]);
  return true;
}

function tick(): void {
  if (!navigator.serviceWorker?.controller) {
    paused.textContent = "waiting for the service worker... (open a proxied page first)";
    return;
  }
  paused.textContent = "";
  post({ type: "zl:getNetLog", since: lastSeq }, (data) => {
    const { entries: fresh, lastSeq: seq, generation, stats } = (data ?? { entries: [] }) as {
      entries: NetEntry[];
      lastSeq: number;
      generation?: number;
      stats?: { native: number; fallback: number };
    };
    statsEl.textContent = stats ? "native " + stats.native + " / fallback " + stats.fallback : "";
    if (generation !== lastGeneration) {
      lastGeneration = generation ?? 0;
      lastSeq = 0;
      entries = [];
      diagLast = 0;
      diagEvents = [];
      traceLast = 0;
      traceEntries = [];
      render();
      return;
    }
    if (fresh.length) {
      entries = [...entries, ...fresh].slice(-500);
      render();
    }
    lastSeq = seq ?? lastSeq;
  });
  post({ type: "zl:getDiag", since: diagLast }, (data) => {
    const d = (data ?? {}) as { events?: DiagEvent[]; lastSeq?: number };
    if (d.events?.length) {
      diagEvents = [...diagEvents, ...d.events].slice(-300);
      renderDiag();
    }
    diagLast = d.lastSeq ?? diagLast;
  });
  post({ type: "zl:getTracing", since: traceLast }, (data) => {
    const d = (data ?? {}) as { entries?: TraceEntry[]; lastSeq?: number; enabled?: boolean };
    if (d.enabled !== undefined && document.activeElement !== traceToggle) traceToggle.checked = d.enabled;
    if (d.entries?.length) {
      traceEntries = [...traceEntries, ...d.entries].slice(-300);
      renderTrace();
    }
    traceLast = d.lastSeq ?? traceLast;
  });
}

tick();
setInterval(tick, 1000);
