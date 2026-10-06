/// <reference lib="webworker" />
/* Response transformation + wasm rewriting orchestration, extracted
   from sw.ts (issue #86). This module owns: the wasm rewriter module
   lifecycle, the worker prelude cache, content-type classification,
   and the streaming HTML/CSS rewrite pipelines. sw.ts injects the
   SW-side state (route readiness, route key, fingerprint script,
   site profile script, degraded flag) through initTransform; the
   getters are lazy and resolved at request time, never at module
   eval, so the call may precede the declarations it closes over. */
import { DIAG } from "./diag";
import { charsetFromHeader, makeDecoder, resolveCharset } from "./headers";
import { docKind, jsBody } from "./transit";
import { initScript, initSplicePoint } from "./pageload";
import { currentPrefix } from "./codec";
import * as rewriterWasm from "./rewriter_wasm/rewriter_wasm.js";

/** SW-side state seam (issue #86). */
export interface TransformDeps {
  /** Resolves once the route key is settled (token mint gate). */
  routeReady: () => Promise<void>;
  /** Route key (b64u), null when not settled / not keyed. */
  routeKey: () => string | null;
  /** Active fingerprint profile script, null when none. */
  fpScript: () => string | null;
  /** Per-site profile script for the given base, null when none. */
  siteScript: (base: string) => Promise<string | null>;
  /** Records a transport-level degradation reason (engineDegraded). */
  setDegraded: (reason: string) => void;
}

let deps: TransformDeps | null = null;

/** Wire the SW state seam. Called once by sw.ts at module eval. */
export function initTransform(d: TransformDeps): void {
  deps = d;
}

/* ---- Streaming rewriter wiring ------------------------------------- */

interface JsRewriter {
  process(chunk: string): string;
  finish(): string;
  add_injection(path: string): void;
  set_blocked_hosts(hosts: string[]): void;
}
interface JsCssRewriter {
  process(chunk: string): string;
  finish(): string;
}
interface RewriterMod {
  JsRewriter: new (origin: string, base: string, prefix: string, scheme: string, key?: string) => JsRewriter;
  JsCssRewriter: new (origin: string, base: string, prefix: string, scheme: string, key?: string) => JsCssRewriter;
  rewriteCss(css: string, origin: string, base: string, prefix: string, scheme: string, key?: string): string;
  /* #46: one-shot external script body pass (URL literals +
     frame-buster neutralization), used by the script-destination
     serve seam. */
  rewriteJsBody(js: string, origin: string, base: string, prefix: string, scheme: string, key?: string): string;
  /* wasm-pack --target web output: `default` is the async init that
     fetches and instantiates the .wasm binary. Without it every
     JsRewriter call dies on an unbound wasm table. */
  default(path?: unknown): Promise<unknown>;
}
let rewriterMod: Promise<RewriterMod> | null = null;
export function rewriter(): Promise<RewriterMod> {
  if (!rewriterMod) {
    rewriterMod = (async () => {
      const mod = rewriterWasm as unknown as RewriterMod;
      // Vite freezes the wasm-pack default URL to the origin root, which 404s
      // when the bundle is aliased under a subpath (LobsterBrowse /zlsw/).
      // Resolve the wasm URL against the SW script URL instead.
      if (typeof mod.default === "function") {
        await mod.default(new URL("rewriter_wasm_bg.wasm", self.location.href));
      }
      return mod;
    })().catch((err) => {
      deps!.setDegraded("rewriter wasm: " + String(err));
      rewriterMod = null; // allow retry on next response
      DIAG.emit({
        category: "REWRITE",
        severity: "error",
        message: "rewriter wasm init failed",
        technicalReason: String(err),
      });
      throw err;
    });
  }
  return rewriterMod;
}

/* 1.6 Hydride: the worker prelude asset is fetched once and cached in
   memory; the live route prefix and the upstream worker URL are baked
   into the injected first line at serve time. */
let preludeCache: string | null = null;
export async function workerPrelude(): Promise<string> {
  if (preludeCache === null) {
    const r = await fetch(new URL("worker-prelude.js", self.location.href).href);
    preludeCache = await r.text();
  }
  return preludeCache;
}

export function isHtml(resp: Response): boolean {
  /* One classification (transit.docKind) for the rewrite branches and
     the transit refinement; XHTML documents are HTML to the rewriter
     (issue C). */
  return docKind(resp.headers.get("content-type") ?? "") === "html";
}
export function isCss(resp: Response): boolean {
  return docKind(resp.headers.get("content-type") ?? "") === "css";
}
export function isJs(resp: Response): boolean {
  return jsBody(resp.headers.get("content-type") ?? "");
}

/** Concatenate held byte chunks (stream-head sniffing). */
function cat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Raw passthrough of an already-started body: one held chunk plus
    the rest of the reader, bytes untouched. */
export function rawFrom(
  head: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      if (head) c.enqueue(head);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) c.enqueue(value);
      }
      c.close();
    },
  });
}

/** HTML bodies: pipe response chunks through the wasm rewriter. The
    bootstrap needs a per-site identity on window.__ZL (an opaque
    token since #32; the real destination never enters the page), so
    a tiny inline script is spliced into the stream head AFTER the
    doctype (quirks fix: it used to ride the very first chunk, before
    the doctype, which forced quirks mode on every proxied document
    that declared one; a doctype-less page keeps the stream-start
    placement and its quirks mode). SiteConfig per-site rules are
    applied to this rewriter instance: injections (Phase 3 hooks) and
    blocked hosts (ad stripping). Issue B: the body decodes with the
    upstream charset (header, BOM, meta prescan, spec default), never
    assumed UTF-8 in; the served copy is re-encoded UTF-8 and the
    caller rewrites the served content-type to charset=utf-8. */
export function rewriteStream(
  body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
  base: string,
  rule: { inject?: string[]; block?: string[] },
  csInject: string[],
  contentType: string,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const modP = rewriter();
  /* Issue #32: the injected contract is { site: <opaque token> },
    computed SW-side from the destination; an active fingerprint
    profile rides the same splice (1.8 Telluride). #55
    follow-up: with a route key the token is a keyed MAC of the
    origin, so the mint waits for routeReady - a token minted before
    the key settled would split one site's storage across both the
    keyed and the legacy prefix. */
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await deps!.routeReady();
      const init = initScript(base, deps!.fpScript() ?? (await deps!.siteScript(base)));
      const emit = (out: string) => {
        if (out) controller.enqueue(encoder.encode(out));
      };
      const reader = body instanceof ReadableStream ? body.getReader() : body;
      try {
        // Rewriter init and construction live inside the try: an init failure
        // (e.g. a wasm 404) used to reject outside the try and kill every fresh
        // HTML response with no diag event and no console error.
        const mod = await modP;
        const rw = new mod.JsRewriter(self.location.origin, base, currentPrefix(), "b64u", deps!.routeKey() ?? undefined); // scheme fixed since #32 (mirror removed)
        for (const path of rule.inject ?? []) rw.add_injection(path);
        if (rule.block?.length) rw.set_blocked_hosts(rule.block);
        for (const u of csInject) rw.add_injection(u);
        /* Stream-head hold (quirks splice + charset): raw bytes
           accumulate until the charset resolves (header label, else
           BOM/meta prescan over the first 1024 bytes), decoded text
           until the doctype splice point resolves (initSplicePoint).
           Bounded: 2KB of still-undecided head falls back to
           stream-start injection, the old placement - never an
           unbounded hold. */
        const headerLabel = charsetFromHeader(contentType);
        let decoder: TextDecoder | null = headerLabel ? makeDecoder(headerLabel) : null;
        let held: Uint8Array[] = [];
        let heldLen = 0;
        let head = "";
        let injected = false;
        const splice = (at: number) => {
          emit(rw.process(head.slice(0, at)));
          controller.enqueue(encoder.encode(init));
          emit(rw.process(head.slice(at)));
          head = "";
          injected = true;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            /* Flush the decoder's incomplete tail: a multi-byte
               sequence truncated at end-of-stream used to be dropped
               silently (issue B). */
            let rest = decoder === null ? "" : decoder.decode();
            if (!injected) {
              if (decoder === null) {
                decoder = makeDecoder(resolveCharset(contentType, cat(held), true));
                head = decoder.decode(cat(held), { stream: true });
                held = [];
                rest = decoder.decode();
              } else {
                head += rest;
                rest = "";
              }
              splice(initSplicePoint(head, true) ?? 0);
            }
            if (rest) emit(rw.process(rest));
            const tail = rw.finish();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            onDone?.();
            return;
          }
          if (injected) {
            emit(rw.process(decoder!.decode(value, { stream: true })));
            continue;
          }
          if (decoder !== null) {
            head += decoder.decode(value, { stream: true });
          } else {
            held.push(value);
            heldLen += value.length;
            if (heldLen < 1024) continue;
            decoder = makeDecoder(resolveCharset(contentType, cat(held), true));
            head += decoder.decode(cat(held), { stream: true });
            held = [];
          }
          const at = initSplicePoint(head);
          if (at !== null) splice(at);
          else if (head.length > 2048) splice(0);
        }
      } catch (e) {
        DIAG.emit({
          category: "REWRITE",
          severity: "error",
          message: "html rewrite stream failed",
          technicalReason: String(e),
          url: base,
        });
        controller.error(e);
      }
    },
  });
}

/* 2.4 Bromide: standalone stylesheet bodies stream chunk by chunk
   through the wasm CSS rewriter (2.3 buffered the whole body for a
   one-shot pass, so large CSS delayed first paint). No window.__ZL
   init is injected here: CSS is not a document, the bootstrap never
   runs in a stylesheet context. The rewriter retains only the
   incomplete url( tail between chunks. Issue B: the body decodes
   with the upstream charset (header, BOM or a leading @charset, all
   within the first bytes, so the head is held only until the
   charset resolves); the served copy is UTF-8 and the caller
   declares it on the served content-type. */
export function cssRewriteStream(
  body: ReadableStream<Uint8Array>,
  base: string,
  contentType: string,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const modP = rewriter();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const mod = await modP;
        const rw = new mod.JsCssRewriter(self.location.origin, base, currentPrefix(), "b64u", deps!.routeKey() ?? undefined); // scheme fixed since #32 (mirror removed)
        const reader = body.getReader();
        const emit = (out: string) => {
          if (out) controller.enqueue(encoder.encode(out));
        };
        const headerLabel = charsetFromHeader(contentType);
        let decoder: TextDecoder | null = headerLabel ? makeDecoder(headerLabel) : null;
        let held: Uint8Array[] = [];
        let heldLen = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            let text = "";
            if (decoder === null) {
              decoder = makeDecoder(resolveCharset(contentType, cat(held), false));
              text = decoder.decode(cat(held), { stream: true });
              held = [];
            }
            /* Flush the decoder's incomplete tail: a multi-byte
               sequence truncated at end-of-stream used to be dropped
               silently (issue B). */
            text += decoder.decode();
            if (text) emit(rw.process(text));
            const tail = rw.finish();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            onDone?.();
            return;
          }
          if (decoder !== null) {
            emit(rw.process(decoder.decode(value, { stream: true })));
            continue;
          }
          held.push(value);
          heldLen += value.length;
          if (heldLen < 64) continue; /* @charset must sit at the very start */
          decoder = makeDecoder(resolveCharset(contentType, cat(held), false));
          emit(rw.process(decoder.decode(cat(held), { stream: true })));
          held = [];
        }
      } catch (e) {
        DIAG.emit({
          category: "REWRITE",
          severity: "error",
          message: "css rewrite stream failed",
          technicalReason: String(e),
          url: base,
        });
        controller.error(e);
      }
    },
  });
}

/** Prewarm the wasm module during SW install: instantiation is the
    slowest cold-path step, so the first HTML response should not pay
    it. sw.ts calls this seam, not the wasm loader (issue #86). */
export function prewarmRewriter(): void {
  void rewriter().catch(() => undefined);
}

/** #46 one-shot external script body pass (URL literals + frame-buster
    neutralization), used by the script-destination serve seam. sw.ts
    depends on this transformer seam rather than the wasm module surface
    (issue #86). Rejects on a wasm load failure; the caller decides
    whether the untransformed body still serves. */
export async function rewriteJsBody(js: string, base: string): Promise<string> {
  const mod = await rewriter();
  return mod.rewriteJsBody(js, self.location.origin, base, currentPrefix(), "b64u", deps!.routeKey() ?? undefined);
}
