/* Zeolite bootstrap: Tier 2 DOM inspection bridge (#550, first slice).

   The devtools page never touches page DOM directly (power-features
   spec §2): the controlling service worker relays inspection requests
   here and this module answers with PLAIN SERIALIZED DATA ONLY - no
   Window, Element or style object ever crosses the relay.

   Authorization shape: the bridge is OFF until the SW pushes
   zl:domInspectCtl {on:true} - the SW only sends that after the host
   page authorized an inspection session for this exact client (the
   host-only zl:domInspect control message, engine-side session
   registry). Teardown: on {on:false} (console restored, ring and
   snapshot cache dropped) and on navigation (a new document realm
   evaluates this module fresh, unauthorized).

   Generation stamp (netlog stampNetGeneration mirror): the module
   eval stamps one per document realm; every reply carries it, the
   engine pins it at authorize time and discards replies whose
   generation no longer matches - a stale devtools cannot inspect a
   later document.

   Bounds: snapshot depth 12 / 500 nodes (truncation counted, not
   silent), computed styles capped at 64 properties, console ring 128
   entries with 8 args x 500 chars each and objects flattened to
   "[object <class>]". input/textarea VALUES are never read and a
   fixed sensitive attribute set is never serialized. Console text
   passes a compact redaction mirroring diag.ts redactSecrets; the
   engine re-runs the authoritative redactSecrets on every string it
   relays, so the page-side pass is defense in depth. */

/* Compact mirror of the diag.ts redactSecrets patterns (SW-side keeps
   the authoritative one): query-string credentials, authorization
   material and token/password/secret assignments. */
const REDACT_QS =
  /([?&#](?:code|state|nonce|code_verifier|id_token|access_token|refresh_token|session_token|credential|g-recaptcha-response|h-captcha-response|cf-turnstile-response)=)[^&#\s]*/gi;
const REDACT_AUTH = /((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi;
const REDACT_KV = /((?:token|password|secret|api[_-]?key)["'\s:=]+)([^&\s;]+)/gi;

function red(s: string): string {
  return s
    .slice(0, 500)
    .replace(REDACT_QS, "$1[redacted]")
    .replace(REDACT_AUTH, "$1[redacted]")
    .replace(REDACT_KV, "$1[redacted]");
}

/* One string per argument; objects never serialize beyond their class
   name, so rendered secrets (input values, tokens) cannot ride along. */
function flatArg(v: unknown): string {
  const t = typeof v;
  if (t === "string") return red(v as string);
  if (t === "number" || t === "boolean" || t === "undefined") return String(v);
  if (t === "bigint" || t === "symbol" || t === "function") return "[" + t + "]";
  try {
    const n = (v as { constructor?: { name?: string } }).constructor?.name;
    return "[object " + (typeof n === "string" && n ? n : "Object") + "]";
  } catch {
    return "[object]";
  }
}

const RING_CAP = 128;
const MAX_DEPTH = 12;
const MAX_NODES = 500;
const STYLE_CAP = 64;
/* Form state that a serialized attribute copy could leak: named, but
   never read (and the .value/.checked properties are never touched
   anywhere in this module). */
const SENSITIVE_ATTRS: Record<string, boolean> = {
  value: true,
  checked: true,
  selected: true,
};

interface CtlMessage {
  type?: string;
  on?: boolean;
  op?: string;
  nodeId?: number;
}

export function applyDomInspect(w: Record<string, unknown>): void {
  const nav = w.navigator as
    | {
        serviceWorker?: {
          controller?: unknown;
          addEventListener: (t: string, f: (ev: MessageEvent) => void) => void;
        };
      }
    | undefined;
  const sw = nav && nav.serviceWorker;
  const ctl = sw && sw.controller;
  if (!sw || !ctl) return;

  const gen = Date.now();
  let auth = false;
  let ring: Array<{ level: string; ts: number; args: string[] }> = [];
  let ringDropped = 0;
  /* Elements of the LAST snapshot, page-side only (never posted). The
     styles op addresses them by snapshot index. */
  let nodes: Array<Record<string, unknown>> = [];

  const consoleObj = w.console as Record<string, unknown> | undefined;
  const originals: Record<string, unknown> = {};
  const LEVELS = ["error", "warn", "log", "info"];

  function capture(level: string, args: unknown[]): void {
    if (ring.length >= RING_CAP) {
      ring.shift();
      ringDropped++;
    }
    const out: string[] = [];
    for (let i = 0; i < args.length && i < 8; i++) out.push(flatArg(args[i]));
    ring.push({ level, ts: Date.now(), args: out });
  }

  function patch(on: boolean): void {
    if (!consoleObj) return;
    for (const level of LEVELS) {
      if (on && originals[level] === undefined) {
        originals[level] = consoleObj[level];
        consoleObj[level] = function (this: unknown, ...args: unknown[]) {
          try {
            capture(level, args);
          } catch {
            /* a hostile argument shape must not break the page's own log */
          }
          return (originals[level] as (...a: unknown[]) => unknown).apply(this, args);
        };
      } else if (!on && originals[level] !== undefined) {
        consoleObj[level] = originals[level];
        delete originals[level];
      }
    }
  }

  function serialize(root: Record<string, unknown>): {
    tree: Record<string, unknown>;
    truncated: boolean;
  } {
    let count = 0;
    let truncated = false;
    nodes = [];
    const walk = (n: Record<string, unknown>, depth: number): Record<string, unknown> => {
      if (count >= MAX_NODES) {
        truncated = true;
        return { truncated: true };
      }
      count++;
      nodes.push(n);
      const o: Record<string, unknown> = { i: nodes.length - 1, tag: n.tagName };
      const id = n.id;
      if (typeof id === "string" && id) o.id = red(id);
      const cls = n.className;
      if (typeof cls === "string" && cls) o.class = red(cls);
      const attrs: Record<string, string> = {};
      const list = n.attributes as Array<{ name: string; value: string }> | undefined;
      if (list) {
        for (let i = 0; i < list.length && i < 32; i++) {
          const name = String(list[i].name).toLowerCase();
          if (SENSITIVE_ATTRS[name]) continue;
          attrs[name] = red(String(list[i].value));
        }
      }
      if (Object.keys(attrs).length) o.attrs = attrs;
      if (depth >= MAX_DEPTH) {
        truncated = true;
        o.truncated = true;
        return o;
      }
      const kids = n.children as Array<Record<string, unknown>> | undefined;
      const out: Array<Record<string, unknown>> = [];
      if (kids) {
        for (let i = 0; i < kids.length; i++) {
          if (count >= MAX_NODES) {
            truncated = true;
            break;
          }
          out.push(walk(kids[i], depth + 1));
        }
      }
      o.children = out;
      return o;
    };
    return { tree: walk(root, 0), truncated };
  }

  function computedStyles(nodeId: number): Array<[string, string]> | null {
    const el = nodes[nodeId];
    if (!el) return null;
    const gcs = w.getComputedStyle as ((n: unknown) => {
      length: number;
      item: (i: number) => string;
      getPropertyValue: (n: string) => string;
    }) | undefined;
    if (!gcs) return null;
    let cs: { length: number; item: (i: number) => string; getPropertyValue: (n: string) => string };
    try {
      cs = gcs(el);
    } catch {
      return null;
    }
    const out: Array<[string, string]> = [];
    const n = Math.min(cs.length, STYLE_CAP);
    for (let i = 0; i < n; i++) {
      const name = cs.item(i);
      out.push([name, red(String(cs.getPropertyValue(name)).slice(0, 200))]);
    }
    return out;
  }

  sw.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== ctl) return;
    const m = ev.data as CtlMessage | null;
    if (!m) return;
    if (m.type === "zl:domInspectCtl") {
      const port = ev.ports && ev.ports[0];
      if (m.on === true) {
        auth = true;
        patch(true);
        if (port) port.postMessage({ ok: true, gen });
      } else {
        /* Teardown on revoke: the page-side view of the session ends. */
        auth = false;
        patch(false);
        ring = [];
        ringDropped = 0;
        nodes = [];
        if (port) port.postMessage({ ok: true, gen });
      }
      return;
    }
    if (m.type !== "zl:domInspectReq" || !auth) return;
    /* The bridge only answers requests the engine relayed for an
       authorized session; a page script cannot mint these (they come
       from the SW, verified by ev.source above). */
    const port = ev.ports && ev.ports[0];
    if (!port) return;
    if (m.op === "snapshot") {
      const doc = w.document as { documentElement?: Record<string, unknown> } | undefined;
      const root = doc && doc.documentElement;
      if (!root) {
        port.postMessage({ ok: false, gen, error: "no document" });
        return;
      }
      const s = serialize(root);
      port.postMessage({ ok: true, gen, tree: s.tree, truncated: s.truncated, nodes: nodes.length });
      return;
    }
    if (m.op === "styles" && typeof m.nodeId === "number") {
      const styles = computedStyles(m.nodeId);
      port.postMessage(
        styles
          ? { ok: true, gen, styles, truncated: nodes.length >= MAX_NODES }
          : { ok: false, gen, error: "no such snapshot node" },
      );
      return;
    }
    if (m.op === "console") {
      port.postMessage({ ok: true, gen, entries: ring, dropped: ringDropped });
      return;
    }
    port.postMessage({ ok: false, gen, error: "bad op" });
  });
}
