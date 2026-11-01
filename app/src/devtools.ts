/* Zeolite DevTools page: network inspector + per-request detail view +
   opt-in rewrite tracing + diagnostics feed (1.2 Halide). This page is
   served by the engine origin, so it is controlled by the same SW and
   can postMessage it. Polls zl:getNetLog, zl:getDiag, zl:getTracing and
   zl:transport once per second. */

interface NetDetail {
  internalUrl: string;
  ttfb: number;
  initiator?: string;
  initiatorType?: string;
  reqHeaders?: Record<string, string>;
  respHeaders?: Record<string, string>;
  cookies?: string[];
}

interface NetEntry {
  seq: number;
  ts: number;
  /** SW-owned request identity, only for verified request exports. */
  traceId?: string;
  clientId?: string;
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
const requestKdlExport = document.getElementById("requestKdlExport") as HTMLButtonElement;
const requestKdlStatus = document.getElementById("requestKdlStatus")!;
const traceRows = document.getElementById("traceRows")!;
const traceToggle = document.getElementById("traceToggle") as HTMLInputElement;
const transportSelect = document.getElementById("transportSelect") as HTMLSelectElement;
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

let selectedRequest: NetEntry | null = null;
/** Per-request detail view (1.2 Halide): everything the SW recorded. */
function showDetail(e: NetEntry): void {
  selectedRequest = e;
  requestKdlExport.disabled = !e.clientId || !e.traceId;
  requestKdlStatus.textContent = requestKdlExport.disabled
    ? "No verified request trace is available for this row." : "";
  const d = e.detail;
  const lines: string[] = [
    "target: " + e.dest,
    "internal: " + (d?.internalUrl ?? e.path),
  ];
  if (e.finalDest) lines.push("final destination: " + e.finalDest);
  lines.push(e.method + " -> " + e.status + "  ttfb " + (d?.ttfb ?? e.ms) + " ms, total " + e.ms + " ms");
  if (d?.initiator) lines.push("initiator: " + d.initiator);
  if (d?.initiatorType) lines.push("initiator type: " + d.initiatorType);
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
  /* Old selection loses identity when a worker generation changes. */
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
      tr.tabIndex = 0;
      tr.addEventListener("click", () => showDetail(e));
      tr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          showDetail(e);
        }
      });
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
  const thEl = th as HTMLElement;
  thEl.tabIndex = 0;
  const apply = () => {
    const key = (th as HTMLElement).dataset.sort as keyof NetEntry;
    if (key === sortKey) sortDesc = !sortDesc;
    else {
      sortKey = key;
      sortDesc = false;
    }
    render();
  };
  thEl.addEventListener("click", apply);
  thEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      apply();
    }
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

// Transport engine toggle (#64): switch the TLS/HTTP engine. Takes
// effect on the NEXT init(): the SW nulls its transport-ready promise
// and the next request re-initializes on the new engine; the running
// client keeps its engine until the service worker restarts.
transportSelect.addEventListener("change", () => {
  post({ type: "zl:transport", engine: transportSelect.value }, () => undefined);
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
    /* #103: the generation is the worker's restart epoch (stamped at
       init), so the transit counters are "since that restart" - the
       label says so. */
    statsEl.textContent = stats
      ? "native " +
        stats.native +
        " / fallback " +
        stats.fallback +
        " (since restart " +
        new Date(generation ?? 0).toLocaleTimeString() +
        ")"
      : "";
    if (generation !== lastGeneration) {
      lastGeneration = generation ?? 0;
      lastSeq = 0;
      entries = [];
      selectedRequest = null;
      requestKdlExport.disabled = true;
      requestKdlStatus.textContent = "Worker restarted; select a request again.";
      diagLast = 0;
      diagEvents = [];
      traceLast = 0;
      traceEntries = [];
      /* #550: an inspection session does not survive the worker that
         authorized it; the stale page view cannot inspect anything. */
      domClient = null;
      domTreeEl.replaceChildren();
      domConsoleEl.textContent = "";
      domStylesEl.textContent = "no node selected";
      domReset("worker restarted; select a request and authorize again");
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
  post({ type: "zl:transport" }, (data) => {
    const d = (data ?? {}) as { engine?: string };
    if (d.engine && document.activeElement !== transportSelect) transportSelect.value = d.engine;
  });
}

/* #494 request-scoped debugger: manual export only. No persistent
   logging or MCP server. The worker itself verifies the selected trace
   belongs to a currently live proxied client and rejects stale rows. */
requestKdlExport.addEventListener("click", () => {
  const request = selectedRequest;
  const ctl = navigator.serviceWorker?.controller;
  if (!request?.traceId || !request.clientId || !ctl) {
    requestKdlStatus.textContent = "Unavailable: select a live request with a verified trace.";
    return;
  }
  requestKdlStatus.textContent = "Collecting request evidence...";
  requestKdlExport.disabled = true;
  const ch = new MessageChannel();
  let settled = false;
  const finish = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(deadline);
    ch.port1.onmessage = null;
    ch.port1.close();
    ch.port2.close();
    requestKdlExport.disabled = false;
    return true;
  };
  const deadline = setTimeout(() => {
    if (finish()) requestKdlStatus.textContent = "Export unavailable: worker did not answer.";
  }, 5000);
  ch.port1.onmessage = ev => {
    if (!finish()) return;
    const data = ev.data as {ok?: boolean; status?: string; kdl?: string};
    if (!data?.ok || typeof data.kdl !== "string" || data.kdl.length > 40000) {
      requestKdlStatus.textContent = "Export unavailable: trace identity expired or report unsupported.";
      return;
    }
    const url = URL.createObjectURL(new Blob([data.kdl], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "zeolite-request.kdl";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    requestKdlStatus.textContent = "KDL report exported for selected request.";
  };
  try {
    ctl.postMessage({
      type: "zl:exportDiagnostics", clientId: request.clientId, traceId: request.traceId,
    }, [ch.port2]);
  } catch {
    finish();
    requestKdlStatus.textContent = "Export unavailable: control request failed.";
  }
});

/* #495: Zeolite Doctor belongs to the engine control plane, not an
   MCP server. Use the verified host page + one-shot MessageChannel.
   This panel shows only fixed redacted Doctor check facts. */
interface DoctorReply {
  ok: boolean;
  healthy: boolean | null;
  checks: Array<{ code: string; status: string; summary: string; remedy?: string }>;
  kdl?: string;
}
const doctorStatus = document.getElementById("doctorStatus")!;
const doctorRows = document.getElementById("doctorRows")!;
const doctorInspect = document.getElementById("doctorInspect") as HTMLButtonElement;
const doctorProbe = document.getElementById("doctorProbe") as HTMLButtonElement;
const doctorExport = document.getElementById("doctorExport") as HTMLButtonElement;
let lastDoctor: DoctorReply | null = null;

function renderDoctor(report: DoctorReply): void {
  doctorRows.replaceChildren();
  doctorStatus.textContent = report.healthy === false
    ? "Confirmed failing checks. Review the evidence below."
    : report.healthy === true ? "All observed checks passed."
      : "Partial inspection — unknown and skipped checks are not passes.";
  for (const check of report.checks.slice(0, 32)) {
    const row = document.createElement("tr");
    const code = document.createElement("td");
    const status = document.createElement("td");
    const evidence = document.createElement("td");
    code.textContent = check.code;
    status.textContent = check.status;
    status.className = "doctor-" + check.status;
    evidence.textContent = check.summary + (check.remedy ? " — " + check.remedy : "");
    row.append(code, status, evidence);
    doctorRows.append(row);
  }
}

function doctorRequest(probeAssets: boolean, onReady?: (report: DoctorReply) => void): void {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) {
    doctorStatus.textContent = "Unavailable: this DevTools page has no controlling service worker.";
    return;
  }
  doctorStatus.textContent = probeAssets ? "Checking same-origin bundle assets..." : "Inspecting engine state...";
  const channel = new MessageChannel();
  let finished = false;
  const settle = (): boolean => {
    if (finished) return false;
    finished = true;
    clearTimeout(timeout);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    return true;
  };
  const timeout = setTimeout(() => {
    if (settle()) doctorStatus.textContent = "Unavailable: Doctor did not answer before the timeout.";
  }, 5500);
  channel.port1.onmessage = (event) => {
    if (!settle()) return;
    const report = event.data as DoctorReply | null;
    if (!report?.ok || !Array.isArray(report.checks) || report.checks.length > 32) {
      doctorStatus.textContent = "Unavailable: Doctor returned no valid report.";
      return;
    }
    lastDoctor = report;
    renderDoctor(report);
    onReady?.(report);
  };
  try {
    ctl.postMessage({ type: "zl:doctor", probeAssets, format: "kdl" }, [channel.port2]);
  } catch {
    settle();
    doctorStatus.textContent = "Unavailable: Doctor request could not be sent.";
  }
}

doctorInspect.addEventListener("click", () => doctorRequest(false));
doctorProbe.addEventListener("click", () => doctorRequest(true));
doctorExport.addEventListener("click", () => {
  const exportReport = (report: DoctorReply) => {
    if (typeof report.kdl !== "string") {
      doctorStatus.textContent = "KDL export unavailable in the current worker build.";
      return;
    }
    const url = URL.createObjectURL(new Blob([report.kdl], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "zeolite-doctor.kdl";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  if (lastDoctor) exportReport(lastDoctor);
  else doctorRequest(false, exportReport);
});

/* #550 Tier 2 DOM inspection, first slice. The devtools page never
   touches a proxied document's DOM: it authorizes a session for a
   live client, and the SW relays bounded requests to that page's
   bootstrap bridge (serialized data only). The generation the
   authorize handshake pins must appear on every reply; a mismatched
   generation is a later document and is discarded, never rendered. */
interface DomNode {
  i: number;
  tag: string;
  id?: string;
  class?: string;
  attrs?: Record<string, string>;
  children?: DomNode[];
  truncated?: boolean;
}
interface DomConsoleEntry {
  level: string;
  ts: number;
  args: string[];
}
const domStatus = document.getElementById("domStatus")!;
const domAuthorizeBtn = document.getElementById("domAuthorize") as HTMLButtonElement;
const domRevokeBtn = document.getElementById("domRevoke") as HTMLButtonElement;
const domSnapshotBtn = document.getElementById("domSnapshot") as HTMLButtonElement;
const domConsoleBtn = document.getElementById("domConsoleBtn") as HTMLButtonElement;
const domStylesEl = document.getElementById("domStyles")!;
const domTreeEl = document.getElementById("domTree")!;
const domConsoleEl = document.getElementById("domConsoleList")!;
let domClient: string | null = null;
let domGen = -1;
let domAuthorized = false;

function domApplyButtons(): void {
  domAuthorizeBtn.disabled = !domClient || domAuthorized;
  domRevokeBtn.disabled = !domAuthorized;
  domSnapshotBtn.disabled = !domAuthorized;
  domConsoleBtn.disabled = !domAuthorized;
}

function domReset(why: string): void {
  domAuthorized = false;
  domGen = -1;
  domApplyButtons();
  domStatus.textContent = why;
}

/* A row selection carries the clientId the SW verified for that
   request's trace; only such verified clients are authorizable. */
function domTargetFromSelection(): string | null {
  return selectedRequest?.clientId ?? null;
}

domAuthorizeBtn.addEventListener("click", () => {
  const clientId = domTargetFromSelection();
  if (!clientId) {
    domStatus.textContent = "No verified client: select a request row first.";
    return;
  }
  domStatus.textContent = "authorizing...";
  post({ type: "zl:domInspect", op: "authorize", clientId }, (data) => {
    if (data?.ok && typeof data.gen === "number") {
      domClient = clientId;
      domGen = data.gen;
      domAuthorized = true;
      domApplyButtons();
      domStatus.textContent = "authorized for this document";
    } else {
      domClient = null;
      domApplyButtons();
      domStatus.textContent = "unavailable: " + (data?.error ?? "no answer");
    }
  });
});

domRevokeBtn.addEventListener("click", () => {
  if (!domClient) return;
  const clientId = domClient;
  post({ type: "zl:domInspect", op: "revoke", clientId }, () => undefined);
  domTreeEl.replaceChildren();
  domStylesEl.textContent = "no node selected";
  domConsoleEl.textContent = "";
  domReset("session revoked");
});

domSnapshotBtn.addEventListener("click", () => {
  if (!domAuthorized || !domClient) return;
  domStatus.textContent = "snapshotting...";
  post({ type: "zl:domInspect", op: "snapshot", clientId: domClient }, (data) => {
    if (!data?.ok) {
      domReset("unavailable: " + (data?.error ?? "no answer"));
      return;
    }
    if (data.gen !== domGen) {
      /* Stale generation: this reply describes a later document. */
      domTreeEl.replaceChildren();
      domReset("stale document generation; authorize again");
      return;
    }
    domTreeEl.replaceChildren();
    renderDomTree(data.tree as DomNode, domTreeEl, 0);
    domStatus.textContent =
      "snapshot: " + (typeof data.nodes === "number" ? data.nodes : "?") + " nodes" +
      (data.truncated ? " (truncated)" : "");
  });
});

function renderDomTree(node: DomNode | undefined, parent: HTMLElement, depth: number): void {
  if (!node || depth > 8) return;
  const row = document.createElement("div");
  row.className = "dn";
  const label =
    "<" + (node.tag ?? "?") + ">" +
    (node.id ? " #" + node.id : "") +
    (node.class ? " ." + node.class.split(/\s+/).slice(0, 3).join(".") : "") +
    (node.truncated ? " …" : "");
  row.textContent = label;
  if (typeof node.i === "number") {
    row.addEventListener("click", () => {
      domTreeEl.querySelectorAll(".dn.sel").forEach((x) => x.classList.remove("sel"));
      row.classList.add("sel");
      requestDomStyles(node.i);
    });
  }
  parent.append(row);
  for (const child of (node.children ?? []).slice(0, 40)) renderDomTree(child, parent, depth + 1);
}

function requestDomStyles(nodeId: number): void {
  if (!domAuthorized || !domClient) return;
  domStylesEl.textContent = "...";
  post({ type: "zl:domInspect", op: "styles", clientId: domClient, nodeId }, (data) => {
    if (!data?.ok) {
      domStylesEl.textContent = "unavailable: " + (data?.error ?? "no answer");
      if (data?.stale) domReset("stale document generation; authorize again");
      return;
    }
    if (data.gen !== domGen) {
      domStylesEl.textContent = "discarded: stale document generation";
      return;
    }
    const styles = (data.styles ?? []) as Array<[string, string]>;
    domStylesEl.textContent = styles.length
      ? styles.map(([k, v]) => k + ": " + v).join("\n")
      : "no computed styles reported";
  });
}

domConsoleBtn.addEventListener("click", () => {
  if (!domAuthorized || !domClient) return;
  post({ type: "zl:domInspect", op: "console", clientId: domClient }, (data) => {
    if (!data?.ok) {
      domConsoleEl.textContent = "unavailable: " + (data?.error ?? "no answer");
      if (data?.stale) domReset("stale document generation; authorize again");
      return;
    }
    if (data.gen !== domGen) {
      domConsoleEl.textContent = "discarded: stale document generation";
      return;
    }
    const entries = (data.entries ?? []) as DomConsoleEntry[];
    domConsoleEl.textContent = entries.length
      ? entries
          .map((e) => fmtTime(e.ts) + " " + e.level + ": " + e.args.join(" "))
          .join("\n") + (data.dropped ? "\n(" + data.dropped + " older entries dropped)" : "")
      : "console ring is empty";
  });
});

tick();
setInterval(tick, 1000);
