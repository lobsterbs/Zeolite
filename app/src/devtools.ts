/* Zeolite DevTools page (Phase 4): network inspector. This page is
   served by the engine origin, so it is controlled by the same SW and
   can postMessage it. It polls zl:getNetLog once per second and keeps a
   stable sort. The network inspector is the priority deliverable; a
   DOM/CSS inspector over a postMessage bridge into proxied pages
   remains a stretch goal. */

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
}

const rows = document.getElementById("rows")!;
const paused = document.getElementById("paused")!;
const statsEl = document.getElementById("stats")!;

let entries: NetEntry[] = [];
let lastSeq = 0;
let lastGeneration = -1;
let sortKey: keyof NetEntry = "seq";
let sortDesc = false;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function fmtBytes(n: number): string {
  if (n < 0) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  return (n / 1024 / 1024).toFixed(1) + " MiB";
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

function tick(): void {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) {
    paused.textContent = "waiting for the service worker... (open a proxied page first)";
    return;
  }
  paused.textContent = "";
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    const { entries: fresh, lastSeq: seq, generation, stats } = (ev.data ?? { entries: [] }) as {
      entries: NetEntry[];
      lastSeq: number;
      generation?: number;
      stats?: { native: number; fallback: number };
    };
    statsEl.textContent = stats ? "native " + stats.native + " / fallback " + stats.fallback : "";
    // A restarted SW restarts the seq counter: reset the cursor (and
    // drop pre-restart rows) instead of silently dropping new ones.
    if (generation !== lastGeneration) {
      lastGeneration = generation ?? 0;
      lastSeq = 0;
      entries = [];
      render();
      return;
    }
    if (fresh.length) {
      entries = [...entries, ...fresh].slice(-500);
      render();
    }
    lastSeq = seq ?? lastSeq;
  };
  ctl.postMessage({ type: "zl:getNetLog", since: lastSeq }, [ch.port2]);
}

tick();
setInterval(tick, 1000);