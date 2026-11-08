/* Service-worker handler for page cosmetic token queries (#551,
   second slice). The page runtime (cosmetic-page.ts, compiled into
   cosmetics-runtime.js) sends the document's class and id tokens
   here and receives the dynamic hide stylesheet. The document URL
   is recovered worker-side from the sender's own client route
   (decodeClientUrl, never a page claim), so a page cannot aim
   cosmetic rules at another document.

   Gates mirror the rewrite-time static arm exactly: the zl:adblock
   toggle, the captcha/anti-bot allowlist, and the per-site adblock
   override all refuse, and the wasm arm answers hidden_css while
   the TS arm answers getCosmeticsFilters with getRulesFromDOM=true
   (the DOM-anchored generic hides the static arm cannot see).

   Bounds: 24 queries per client (the same cap the page runtime
   enforces; worker-side is defense in depth), 512 classes and 128
   ids per query, one bounded DIAG row per client emitted at the
   done report or the first refusal - counts only, never selectors
   or tokens. */

import { getDomain } from "tldts";
import { DIAG } from "./diag";
import { decodeClientUrl } from "./codec";
import { allowlistedHostFor, isRulesEnabled, loadRules, siteOverrideFor } from "./rules";
import { ghosteryEngine, wasmAdblockEngine } from "./ghostery";
import { COSMETIC_STYLE_CAP, type CosmeticEngineLike } from "./cosmetics";

/* Same caps the page runtime enforces; the worker re-checks so a
   hostile page build cannot exceed them. */
const QUERY_CAP = 24;
const CLIENT_CAP = 512;
const CLASSES_CAP = 512;
const IDS_CAP = 128;
const TOKEN_LEN = 128;

interface ClientState {
  queries: number;
  applied: number;
  reported: boolean;
}

/* Memory only, like every matcher-adjacent state: a worker restart
   drops it, and nothing persists tokens or styles. */
const clients = new Map<string, ClientState>();

function stateFor(id: string): ClientState {
  let s = clients.get(id);
  if (!s) {
    if (clients.size >= CLIENT_CAP) {
      const oldest = clients.keys().next();
      if (!oldest.done) clients.delete(oldest.value);
    }
    s = { queries: 0, applied: 0, reported: false };
    clients.set(id, s);
  }
  return s;
}

function reply(port: { postMessage(d: unknown): void; close(): void }, obj: Record<string, unknown>): void {
  try {
    port.postMessage(obj);
  } catch {
    /* client went away */
  } finally {
    try {
      port.close();
    } catch {
      /* already closed */
    }
  }
}

/* One bounded DIAG row per client, counts only. */
function diagOnce(state: ClientState, message: string, url: string): void {
  if (state.reported) return;
  state.reported = true;
  DIAG.emit({
    category: "REWRITE",
    cause: "rewrite",
    severity: "info",
    stage: "REWRITE_STARTED",
    message,
    url,
  });
}

/* Defensive truncation of page-supplied token arrays: a hostile or
   buggy page build cannot push an unbounded array through. */
function boundedTokens(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (let i = 0; i < v.length && out.length < cap; i++) {
    const t = v[i];
    if (typeof t === "string" && t.length > 0 && t.length <= TOKEN_LEN) out.push(t);
  }
  return out;
}

export async function handleCosmeticTokens(e: ExtendableMessageEvent): Promise<void> {
  const port = e.ports?.[0];
  const client = e.source as { id?: unknown; url?: unknown } | null;
  if (!port || !client || typeof client.id !== "string" || typeof client.url !== "string") return;
  const msg = e.data as { classes?: unknown; ids?: unknown; done?: unknown } | null;

  let docUrl: string | null = null;
  try {
    docUrl = decodeClientUrl(new URL(client.url));
  } catch {
    docUrl = null;
  }
  /* A sender whose client URL is not a proxied route (the host page,
     the devtools UI) gets the same honest off reply; no state. */
  if (!docUrl) {
    reply(port, { ok: true, off: true });
    return;
  }
  const state = stateFor(client.id);

  /* Done report: the page runtime finished (budget exhausted or the
     page is hiding); this is where the one bounded row lands. */
  if (msg?.done === true) {
    diagOnce(
      state,
      "adblock cosmetic dyn arm: " + state.queries + " queries, " + state.applied + " selectors applied, done",
      docUrl,
    );
    clients.delete(client.id);
    reply(port, { ok: true, done: true });
    return;
  }

  /* Gates, identical to the static arm at rewrite time. */
  const engineRules = await loadRules();
  if (
    !isRulesEnabled() ||
    allowlistedHostFor(engineRules, docUrl, "document") !== null ||
    siteOverrideFor(docUrl)?.adblock === false
  ) {
    diagOnce(state, "adblock cosmetic dyn arm refused: toggle, allowlist or per-site override", docUrl);
    reply(port, { ok: true, off: true });
    return;
  }

  if (state.queries >= QUERY_CAP) {
    diagOnce(
      state,
      "adblock cosmetic dyn arm: query budget exhausted (" + QUERY_CAP + "), refusing further queries",
      docUrl,
    );
    reply(port, { ok: true, off: true });
    return;
  }
  state.queries += 1;

  const classes = boundedTokens(msg?.classes, CLASSES_CAP);
  const ids = boundedTokens(msg?.ids, IDS_CAP);
  let hostname = "";
  try {
    hostname = new URL(docUrl).hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  const wasm = wasmAdblockEngine();
  let styles = "";
  if (wasm) {
    try {
      styles = wasm.hidden_css(docUrl, JSON.stringify(classes), JSON.stringify(ids));
    } catch {
      styles = "";
    }
    if (typeof styles !== "string") styles = "";
  } else {
    const eng = ghosteryEngine() as unknown as CosmeticEngineLike | null;
    if (!eng) {
      /* Lists still loading: the page runtime retries once. */
      reply(port, { ok: true, pending: true });
      return;
    }
    try {
      const out = eng.getCosmeticsFilters({
        url: docUrl,
        hostname,
        domain: getDomain(hostname) ?? "",
        classes,
        ids,
        /* Only the DOM-anchored arm: base, hostname, injection and
           extended rules were already answered at rewrite time. */
        getBaseRules: false,
        getRulesFromDOM: true,
        getRulesFromHostname: false,
        getInjectionRules: false,
        getExtendedRules: false,
        callerContext: "zl-cosmetic-dyn",
      });
      styles = typeof out.styles === "string" ? out.styles : "";
    } catch {
      styles = "";
    }
  }
  if (styles.length > COSMETIC_STYLE_CAP) styles = styles.slice(0, COSMETIC_STYLE_CAP);
  state.applied += Math.min(styles ? styles.split("{").length - 1 : 0, 4096);
  reply(port, { ok: true, styles });
}
