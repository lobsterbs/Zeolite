/* Zeolite extension subsystem: browser.scripting.

   executeScript/insertCSS read the files out of the extension's own
   package (server side) and push the code to the target page over
   the SW->page channel. The page-side listener (LISTENER_SOURCE,
   served at /zl-cs/__scripting.js and injected by the rewriter
   whenever any enabled extension holds the scripting permission)
   verifies it is the intended target page, then runs the code in a
   Function scope with the same content-script API surface.

   Permission model: "scripting" plus a host permission for the
   target tab's URL, enforced HERE. The page listener trusts only
   the service worker (ev.source === controller) but cannot
   re-verify host permissions, so this check is the boundary.

   #517: executeScript gains Firefox's func injection and result
   capture. The SW transfers one end of a MessageChannel with the
   injection; the page answers exactly once with an InjectionResult
   per executed unit (the func's return value, or the script's
   completion value, or an error entry - errors are results, as in
   Firefox). A page with no scripting listener (about:blank-class
   destinations, or no controller) rejects with an honest error after
   the 30s window instead of pretending the script ran. Frame
   targeting and non-page worlds are rejected honestly: injected
   code runs in the page world, in the main frame. */

import { extensions } from "./manager";
import { TABS } from "./tabs";
import { hostPatternsMatch } from "./permissions";
import type { ExtensionId, ExtensionRecord } from "./types";

/** Structured-clone validation for func args (Firefox rejects
    non-cloneable args with a TypeError). The SW->page channel is
    structured-clone based, so the engine's cloneable set is the real
    one: primitives (NaN/Infinity included), plain arrays and plain
    objects. Functions, symbols, undefined, bigint and cycles are not
    cloneable - a JSON round-trip would silently turn functions into
    null, which is exactly the kind of quiet lie this engine avoids. */
function assertCloneable(v: unknown, seen: WeakSet<object>): void {
  if (v === null) return;
  const t = typeof v;
  if (t === "string" || t === "boolean" || t === "number") return;
  if (t === "function" || t === "symbol" || t === "undefined" || t === "bigint") {
    throw new Error("zeolite: scripting.executeScript: args must be structured-cloneable");
  }
  if (t !== "object") {
    throw new Error("zeolite: scripting.executeScript: args must be structured-cloneable");
  }
  if (seen.has(v as object)) {
    throw new Error("zeolite: scripting.executeScript: args must be structured-cloneable (cyclic)");
  }
  seen.add(v as object);
  if (Array.isArray(v)) {
    for (const x of v) assertCloneable(x, seen);
  } else if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
    throw new Error("zeolite: scripting.executeScript: args must be structured-cloneable (plain objects and arrays only)");
  } else {
    for (const x of Object.values(v as Record<string, unknown>)) assertCloneable(x, seen);
  }
  seen.delete(v as object);
}

export interface ScriptingInjection {
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
  files?: string[];
  /** #517: a real function (serialized with String()) or its source. */
  func?: unknown;
  /** #517: structured-cloneable arguments for func (JSON subset). */
  args?: unknown[];
  /** Accepted; delivery timing follows the SW->page channel. */
  injectImmediately?: boolean;
  /** Only the page world exists here, which is Firefox's "MAIN". */
  world?: string;
}

/** Firefox's InjectionResult: one entry per executed unit, errors as
    entries rather than rejections. */
export interface InjectionResult {
  result?: unknown;
  error?: string;
  frameId: number;
}

export interface ScriptingMessage {
  type: "zl:scripting";
  extId: ExtensionId;
  dest: string;
  js: string[];
  css: string[];
  /* #517: func injection and the results handshake. */
  func?: string;
  args?: unknown[];
  wantResult: boolean;
}

/** The 30s answer window matches the page-side extension messaging
    timeout; a silent page is an error, not a fake success. */
const REPLY_TIMEOUT_MS = 30000;

export class ScriptingHost {
  private dispatch: ((msg: ScriptingMessage, reply: MessagePort | null) => void) | null = null;

  setDispatch(fn: ((msg: ScriptingMessage, reply: MessagePort | null) => void) | null): void {
    this.dispatch = fn;
  }

  private check(ext: ExtensionRecord, tabId: number | undefined): string {
    if (tabId === undefined) {
      throw new Error("zeolite: scripting requires a target tabId");
    }
    if (!ext.permissions.includes("scripting")) {
      throw new Error("zeolite: permission 'scripting' not granted to this extension");
    }
    const tab = TABS.get(tabId);
    if (!tab) throw new Error("Invalid tab ID: " + tabId);
    if (!hostPatternsMatch(ext.hostPermissions, tab.url)) {
      throw new Error("zeolite: host permission for '" + tab.url + "' not granted to this extension");
    }
    return tab.url;
  }

  private async readFiles(extId: ExtensionId, files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      const path = f.startsWith("/") ? f : "/" + f;
      const bytes = await extensions.getResource(extId, path, { fromWeb: false });
      if (!bytes) throw new Error("file not found in extension package: " + f);
      out.push(new TextDecoder().decode(bytes));
    }
    return out;
  }

  /** Send the injection and await the page's one-shot results reply.
      The reply port travels with the message; an unanswered port
      rejects after the window instead of faking results. */
  private runWithResults(msg: ScriptingMessage): Promise<InjectionResult[]> {
    if (!this.dispatch) {
      return Promise.reject(new Error("zeolite: scripting dispatch is not wired"));
    }
    return new Promise<InjectionResult[]>((resolve, reject) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => {
        try {
          ch.port1.close();
        } catch {
          /* already closed */
        }
        reject(new Error("zeolite: no scripting listener answered on the target page"));
      }, REPLY_TIMEOUT_MS);
      ch.port1.onmessage = (ev: MessageEvent) => {
        clearTimeout(timer);
        const d = ev.data as { results?: unknown } | null;
        const results = Array.isArray(d?.results) ? (d.results as InjectionResult[]) : [];
        resolve(results.map((r) => ({ ...(r ?? {}), frameId: 0 })));
      };
      try {
        this.dispatch!(msg, ch.port2);
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async executeScript(ext: ExtensionRecord, inj: ScriptingInjection): Promise<InjectionResult[]> {
    const dest = this.check(ext, inj?.target?.tabId);
    const target = (inj?.target ?? {}) as Record<string, unknown>;
    if (target.allFrames === true || (Array.isArray(target.frameIds) && target.frameIds.length > 0)) {
      throw new Error(
        "zeolite: scripting frame targeting is not supported (injected scripts run in the page world, main frame only)",
      );
    }
    if (inj.world !== undefined && inj.world !== "MAIN") {
      throw new Error("zeolite: scripting world '" + String(inj.world) + "' is not available (injected scripts run in the page world)");
    }
    const hasFiles = Array.isArray(inj.files) && inj.files.length > 0;
    const func = inj.func;
    if (hasFiles && func !== undefined) {
      throw new Error("zeolite: scripting.executeScript: files and func cannot be combined");
    }
    if (!hasFiles && func === undefined) {
      throw new Error("zeolite: scripting.executeScript: requires files or func");
    }
    let funcSrc: string | undefined;
    let argsValue: unknown[] | undefined;
    if (func !== undefined) {
      if (typeof func === "function") funcSrc = String(func);
      else if (typeof func === "string" && func.trim().length > 0) funcSrc = func;
      else throw new Error("zeolite: scripting.executeScript: func must be a function");
      if (inj.args !== undefined) {
        if (!Array.isArray(inj.args)) {
          throw new Error("zeolite: scripting.executeScript: args must be an array");
        }
        for (const x of inj.args) assertCloneable(x, new WeakSet());
        /* The channel to the page is structured-clone based, so the
           original values (NaN/Infinity included) travel untouched. */
        argsValue = inj.args;
      }
    }
    const js = hasFiles ? await this.readFiles(ext.id, inj.files as string[]) : [];
    const msg: ScriptingMessage = {
      type: "zl:scripting",
      extId: ext.id,
      dest,
      js,
      css: [],
      wantResult: true,
      ...(funcSrc !== undefined
        ? { func: funcSrc, ...(argsValue !== undefined ? { args: argsValue } : {}) }
        : {}),
    };
    return this.runWithResults(msg);
  }

  async insertCSS(ext: ExtensionRecord, inj: ScriptingInjection): Promise<void> {
    const dest = this.check(ext, inj?.target?.tabId);
    if (inj?.func !== undefined) {
      throw new Error("zeolite: scripting.insertCSS does not run scripts");
    }
    const css = await this.readFiles(ext.id, inj.files ?? []);
    this.dispatch?.({ type: "zl:scripting", extId: ext.id, dest, js: [], css, wantResult: false }, null);
  }
}

export const SCRIPTING = new ScriptingHost();

/* Page-side listener: injected once per document when any enabled
   extension holds the scripting permission. It accepts messages
   only from the controlling service worker and only for its own
   page destination. #517: when the injection carries a reply port,
   the listener answers exactly once with one InjectionResult per
   executed unit - the func's return value or the file's completion
   value (eval's completion value), errors as entries. */
export const LISTENER_SOURCE = [
  "(function () {",
  "  \"use strict\";",
  "  var ctl = navigator.serviceWorker && navigator.serviceWorker.controller;",
  "  if (!ctl) return;",
  "  function chan(ext, req) {",
  "    return new Promise(function (resolve, reject) {",
  "      var mc = new MessageChannel();",
  "      var t = setTimeout(function () {",
  "        reject(new Error(\"zeolite: extension message timed out\"));",
  "      }, 30000);",
  "      mc.port1.onmessage = function (ev) {",
  "        clearTimeout(t);",
  "        var d = ev.data || {};",
  "        if (d.ok) resolve(d.response);",
  "        else reject(new Error(d.error || \"zeolite: extension messaging failed\"));",
  "      };",
  "      ctl.postMessage({ type: \"zl:ext\", extId: ext, msg: req }, [mc.port2]);",
  "    });",
  "  }",
  "  function api(ext) {",
  "    return {",
  "      runtime: {",
  "        id: ext,",
  "        getURL: function (p) {",
  "          return \"/zl-ext/\" + ext + (p.charAt(0) === \"/\" ? p : \"/\" + p);",
  "        },",
  "        sendMessage: function (m) { return chan(ext, m); },",
  "        onMessage: {",
  "          addListener: function () {",
  "            throw new Error(\"zeolite: runtime.onMessage in injected scripts is not supported yet\");",
  "          },",
  "          removeListener: function () {},",
  "          hasListener: function () { return false; },",
  "        },",
  "      },",
  "      storage: {",
  "        local: {",
  "          get: function (k) { return chan(ext, { __zlStorage: \"local\", op: \"get\", keys: k }); },",
  "          set: function (i) { return chan(ext, { __zlStorage: \"local\", op: \"set\", items: i }); },",
  "          remove: function (k) { return chan(ext, { __zlStorage: \"local\", op: \"remove\", keys: k }); },",
  "          clear: function () { return chan(ext, { __zlStorage: \"local\", op: \"clear\" }); },",
  "        },",
  "      },",
  "    };",
  "  }",
  "  function errText(e) { return String((e && e.message) || e); }",
  "  function runOne(browser, code) {",
  "    try {",
  "      return { result: new Function(\"browser\", \"chrome\", '\"use strict\";\\nreturn eval(' + JSON.stringify(code) + ');')(browser, browser) };",
  "    } catch (e) {",
  "      return { error: errText(e) };",
  "    }",
  "  }",
  "  function runFunc(browser, src, args) {",
  "    try {",
  "      var mk = new Function(\"browser\", \"chrome\", \"args\", \"return (\" + src + \").apply(null, args);\");",
  "      return { result: mk(browser, browser, args) };",
  "    } catch (e) {",
  "      return { error: errText(e) };",
  "    }",
  "  }",
  "  navigator.serviceWorker.addEventListener(\"message\", function (ev) {",
  "    if (ev.source !== ctl) return;",
  "    var m = ev.data;",
  "    if (!m || m.type !== \"zl:scripting\") return;",
  "    var dest = (window.__ZL && window.__ZL.dest) || document.baseURI;",
  "    if (m.dest !== dest) return;",
  "    var browser = api(m.extId);",
  "    for (var i = 0; i < (m.css || []).length; i++) {",
  "      var s = document.createElement(\"style\");",
  "      s.textContent = m.css[i];",
  "      (document.head || document.documentElement).appendChild(s);",
  "    }",
  "    var out = [];",
  "    if (m.func) {",
  "      out.push(runFunc(browser, m.func, m.args || []));",
  "    } else {",
  "      var js = m.js || [];",
  "      for (var j = 0; j < js.length; j++) out.push(runOne(browser, js[j]));",
  "    }",
  "    if (m.wantResult && ev.ports && ev.ports[0]) {",
  "      try { ev.ports[0].postMessage({ results: out }); } catch (e2) { /* the caller stopped waiting */ }",
  "    }",
  "  });",
  "})();",
].join("\n");
