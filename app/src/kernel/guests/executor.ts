/* #477 stage: guest execution over a page-created Worker realm.

   Architecture decision (2026-10-27, settles the isolation gate from
   suite/e2e/sw-capability.mjs): ServiceWorkerGlobalScope exposes no
   Worker constructor, so the engine SW cannot create any realm of
   its own. The only proven-isolated, terminable realm available is a
   DedicatedWorker created by a page context on the engine origin.
   The embedding application keeps app/guest-host.html open (the same
   pattern as the zlsw-register page) and bridges it to the SW over
   the control plane. The kernel never touches the guest realm
   directly: the host page builds the worker from a blob, transfers
   one MessagePort in, and reports spawn, error and termination back
   on the same control port.

   Wave 1 honest limits, by design (docs/virtual-service-worker-phase2.md):
   guests are network-blind (fetch, XMLHttpRequest, WebSocket,
   importScripts shadowed at spawn), receive no kernel storage handles
   (caches, indexedDB shadowed), get no fetch events (the wave-2 seam dispatchFetch adds a kernel-side synthetic fetch dispatch with a 250 ms fail-closed budget, not yet wired into the live engine request path), controllerchange
   and push are never dispatched, waitUntil is accepted and not
   awaited, the spawn trigger is a host-only control message, and a
   dead handshake is only reaped on the next kernel interaction (no
   timer inside the kernel). Proxied-page register capture stays
   virtual-only in this wave. */

import { canonicalGuestRegistration, guestScopeMatches } from "./registration";
import { DIAG } from "../../diag";

/** Hard cap on the guest script body the kernel will ever wrap. */
export const GUEST_SCRIPT_MAX = 256 * 1024;

/** Deadline for the host handshake of one spawn or terminate, ms. */
export const GUEST_HANDSHAKE_MS = 10000;

/** #477 wave 2: hard fail-closed budget for one synthetic guest fetch.
    A guest realm may loop or never answer; the engine never waits past
    this. */
export const GUEST_FETCH_BUDGET_MS = 250;

/** #477 wave 2: upper bound on a synthetic guest response body.
    Above it the outcome fails closed to the engine path. */
export const GUEST_FETCH_BODY_MAX = 2 * 1024 * 1024;

/** #477 wave 2: plain structured request handed to the guest realm.
    No live Request object, no stream, no privileged handle crosses the
    guest boundary. */
export interface GuestFetchRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  destination?: string;
  mode?: string;
  clientId?: string;
}

/** #477 wave 2: synthetic fetch outcome. handled:false means the
    engine request path serves the request exactly as with no guest. */
export type GuestFetchOutcome =
  | { handled: false }
  | { handled: true; status: number; headers: Record<string, string>; body: string | null };

/** #477 wave 2: a synthetic guest response is used only when every
    field is bounded and well-typed; anything else fails closed. */
function validGuestFetchResponse(
  r: unknown,
): r is { status: number; headers?: Record<string, string>; body?: string | null } {
  if (!r || typeof r !== 'object') return false;
  const v = r as Record<string, unknown>;
  if (typeof v.status !== "number" || !Number.isInteger(v.status) || v.status < 100 || v.status > 599) return false;
  if (v.headers !== undefined && v.headers !== null) {
    if (typeof v.headers !== 'object' || Array.isArray(v.headers)) return false;
    for (const [k, val] of Object.entries(v.headers)) {
      if (typeof k !== 'string' || typeof val !== 'string') return false;
    }
  }
  if (v.body !== undefined && v.body !== null && typeof v.body !== 'string') return false;
  if (typeof v.body === 'string' && v.body.length > GUEST_FETCH_BODY_MAX) return false;
  return true;
}

/** Minimal structural port the kernel needs. Mirrors wsbridge's
    PortLike so a real MessagePort plugs in without a cast. */
export interface GuestPortLike {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface GuestSpawnMessage {
  pageUrl: string;
  scriptURL: string;
  scope?: string;
  script: string;
}

export interface GuestReply {
  ok: boolean;
  error?: string;
  origin?: string;
}

type GuestReplyFn = (r: GuestReply) => void;

interface GuestRecord {
  origin: string;
  state: "spawning" | "running" | "terminating";
  scope: string;
  scriptURL: string;
  host: GuestPortLike;
  guest: GuestPortLike | null;
  deadlineAt: number;
}

export type GuestListener = (origin: string, data: unknown) => void;

/** Harness prelude prepended to the guest body. Keeps a minimal,
    honest service-worker facade and no kernel surfaces: network and
    storage globals are shadowed, self.postMessage is rerouted to the
    kernel port (a guest cannot reach the host page directly), and
    listeners are captured rather than trusted. */
export function guestHarness(scope: string, scriptURL: string): string {
  const meta = JSON.stringify({ scope, scriptURL });
  return (
    '"use strict";(function(){var ZL=' + meta + ";" +
    "var L={},port=null;" +
    'self.addEventListener("message",function(e){' +
    'if(e.data&&e.data.zl==="harnessPort"&&e.ports&&e.ports[0]){' +
    "port=e.ports[0];port.onmessage=function(ev){" +
    'var d=ev.data;if(!d||d.zl!=="guestEvent")return;' +
    "var f=L[d.type]||[];" +
    "if(d.type===\"fetch\"&&(!d.data||!f.length)){port.postMessage({zl:\"guestFetchNoHandler\",id:d.data&&d.data.id});return;}" +
    "var g={type:d.type,data:d.data,source:null,waitUntil:function(){}};" +
    "if(d.type===\"fetch\"&&d.data){g.request=d.data.request;" +
    "g.respondWith=function(p){Promise.resolve(p).then(function(r){port.postMessage({zl:\"guestFetchResponse\",id:d.data.id,response:r});}).catch(function(err){port.postMessage({zl:\"guestFetchResponse\",id:d.data.id,error:String(err)});});};}" +
    'for(var i=0;i<f.length;i++){try{f[i](g);}catch(err){if(port)port.postMessage({zl:"guestError",error:String(err)});}}' +
    '};port.postMessage({zl:"guestReady"});}});' +
    "self.addEventListener=function(t,f){(L[t]=L[t]||[]).push(f);};" +
    "self.removeEventListener=function(t,f){var a=L[t]||[];var i=a.indexOf(f);if(i>=0)a.splice(i,1);};" +
    '["fetch","XMLHttpRequest","WebSocket","importScripts","caches","indexedDB"].forEach(function(k){' +
    "try{Object.defineProperty(self,k,{value:undefined,configurable:true,writable:true});}catch(err){}});" +
    'self.postMessage=function(d){if(port)port.postMessage({zl:"guestMessage",data:d});};' +
    'self.registration={scope:ZL.scope,scriptURL:ZL.scriptURL,updateViaCache:"none",installing:null,waiting:null,' +
    'active:{scriptURL:ZL.scriptURL,state:"activated",onstatechange:null},' +
    'update:function(){return Promise.reject(new Error("update unsupported in the guest harness"));},' +
    'unregister:function(){if(port)port.postMessage({zl:"guestControl",op:"unregister"});return Promise.resolve(false);},' +
    "getNotifications:function(){return Promise.resolve([]);}};" +
    "self.skipWaiting=function(){};" +
    "})();\n"
  );
}

export class GuestKernel {
  private hosts: GuestPortLike[] = [];
  private guests = new Map<string, GuestRecord>();
  private now: () => number;
  private onMessage: GuestListener | null = null;
  private fetchSeq = 0;
  private fetchPending = new Map<
    number,
    { origin: string; timer: ReturnType<typeof setTimeout>; done: (o: GuestFetchOutcome) => void }
  >();

  constructor(now: () => number) {
    this.now = now;
  }

  /** Optional sink for guest-originated messages. */
  listener(fn: GuestListener): void {
    this.onMessage = fn;
  }

  /** A guest host page announced itself with a control port. */
  registerHost(port: GuestPortLike): void {
    port.onmessage = (ev) => this.hostMessage(ev.data, port);
    this.hosts.push(port);
    DIAG.emit({
      category: "SERVICE_WORKER",
      severity: "info",
      cause: "unknown",
      message: "guest host page connected",
    });
  }

  /** Lazy reaping: a spawn or terminate handshake past its deadline
      is discarded on the next kernel interaction. No timer runs
      inside the kernel, so a dead handshake may sit idle until then;
      this is the documented wave-1 limit. */
  tick(): void {
    const t = this.now();
    for (const [origin, g] of this.guests) {
      if (t > g.deadlineAt && g.state !== "running") {
        this.guests.delete(origin);
        DIAG.emit({
          category: "SERVICE_WORKER",
          severity: "warning",
          cause: "unknown",
          message: "guest handshake deadline exceeded; state discarded",
          technicalReason: "state " + g.state + " origin " + origin,
        });
      }
    }
  }

  spawn(msg: GuestSpawnMessage, reply: GuestReplyFn): void {
    this.tick();
    let identity;
    try {
      identity = canonicalGuestRegistration(msg.pageUrl, msg.scriptURL, msg.scope);
    } catch (err) {
      reply({ ok: false, error: err instanceof TypeError ? err.message : String(err) });
      return;
    }
    if (typeof msg.script !== "string" || msg.script.length === 0 || msg.script.length > GUEST_SCRIPT_MAX) {
      reply({ ok: false, error: "guest script body missing or above the size cap" });
      return;
    }
    const existing = this.guests.get(identity.origin);
    if (existing && existing.state !== "terminating") {
      reply({ ok: false, error: "guest already active for origin; terminate it first" });
      return;
    }
    const host = this.hosts[this.hosts.length - 1];
    if (!host) {
      reply({ ok: false, error: "no guest host page connected" });
      return;
    }
    this.guests.set(identity.origin, {
      origin: identity.origin,
      state: "spawning",
      scope: identity.scope,
      scriptURL: identity.scriptURL,
      host,
      guest: null,
      deadlineAt: this.now() + GUEST_HANDSHAKE_MS,
    });
    host.postMessage({
      op: "spawn",
      origin: identity.origin,
      script: guestHarness(identity.scope, identity.scriptURL) + msg.script,
    });
    DIAG.emit({
      category: "SERVICE_WORKER",
      severity: "info",
      cause: "unknown",
      message: "guest spawn requested",
      technicalReason: identity.origin,
    });
    reply({ ok: true, origin: identity.origin });
  }

  terminate(origin: string, reply?: GuestReplyFn): void {
    this.tick();
    const g = this.guests.get(origin);
    if (!g) {
      if (reply) reply({ ok: false, error: "no guest for origin" });
      return;
    }
    g.state = "terminating";
    g.deadlineAt = this.now() + GUEST_HANDSHAKE_MS;
    g.host.postMessage({ op: "terminate", origin });
    /* #477 wave 2: a terminating realm never answers pending fetches;
       fail them closed to the engine path immediately. */
    for (const [id, p] of this.fetchPending) {
      if (p.origin === origin) {
        this.fetchPending.delete(id);
        clearTimeout(p.timer);
        p.done({ handled: false });
      }
    }
    DIAG.emit({
      category: "SERVICE_WORKER",
      severity: "info",
      cause: "unknown",
      message: "guest termination requested",
      technicalReason: origin,
    });
    if (reply) reply({ ok: true });
  }

  private hostMessage(data: unknown, _port: GuestPortLike): void {
    const m = data as { kind?: unknown; origin?: unknown; port?: unknown; error?: unknown };
    if (!m || typeof m !== "object" || typeof m.kind !== "string") return;
    const origin = typeof m.origin === "string" ? m.origin : "";
    if (m.kind === "zl:guestSpawned") {
      const g = this.guests.get(origin);
      const gp = m.port as GuestPortLike | undefined;
      /* Stray confirmations (a late reply to a superseded spawn) must
         not disturb a newer record for the same origin. */
      if (!g || g.state !== "spawning" || !gp || typeof gp.postMessage !== "function") return;
      g.guest = gp;
      g.state = "running";
      g.deadlineAt = Infinity;
      gp.onmessage = (ev) => this.guestMessage(origin, ev.data);
      /* Real install/activate ordering, minus the waiting period the
         virtual registration facade never modeled. */
      gp.postMessage({ zl: "guestEvent", type: "install" });
      gp.postMessage({ zl: "guestEvent", type: "activate" });
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        cause: "unknown",
        message: "guest running",
        technicalReason: origin,
      });
    } else if (m.kind === "zl:guestSpawnFailed") {
      const g = this.guests.get(origin);
      if (!g || g.state !== "spawning") return;
      this.guests.delete(origin);
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest spawn failed",
        technicalReason: String(m.error ?? "").slice(0, 200),
      });
    } else if (m.kind === "zl:guestTerminated") {
      const g = this.guests.get(origin);
      /* Only a record we marked terminating is deleted; a stale
         confirmation must not kill a newer spawn. */
      if (!g || g.state !== "terminating") return;
      this.guests.delete(origin);
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        cause: "unknown",
        message: "guest terminated",
        technicalReason: origin,
      });
    } else if (m.kind === "zl:guestError") {
      /* The worker threw. Contain it: terminate the guest realm. */
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest worker error; terminating",
        technicalReason: typeof m.error === "string" ? m.error.slice(0, 200) : "",
      });
      this.terminate(origin);
    }
  }

  private guestMessage(origin: string, data: unknown): void {
    const d = data as { zl?: unknown; data?: unknown; error?: unknown; op?: unknown };
    if (!d || typeof d !== "object") return;
    if (d.zl === "guestMessage") {
      if (this.onMessage) {
        try {
          this.onMessage(origin, d.data);
        } catch {
          /* Kernel listener isolation: a listener crash never reaches
             the guest realm. */
        }
      }
    } else if (d.zl === "guestError") {
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest script error contained",
        technicalReason: typeof d.error === "string" ? d.error.slice(0, 200) : "",
      });
    } else if (d.zl === "guestFetchResponse") {
      const fr = d as { id?: unknown; response?: unknown; error?: unknown };
      const p = typeof fr.id === "number" ? this.fetchPending.get(fr.id) : undefined;
      if (!p) return;
      const resp = fr.response;
      if (typeof fr.error === "string" || !validGuestFetchResponse(resp)) {
        /* Malformed, oversize or errored guest answers fail closed. */
        p.done({ handled: false });
        return;
      }
      p.done({ handled: true, status: resp.status, headers: { ...(resp.headers ?? {}) }, body: resp.body ?? null });
    } else if (d.zl === "guestFetchNoHandler") {
      const fh = d as { id?: unknown };
      const p = typeof fh.id === "number" ? this.fetchPending.get(fh.id) : undefined;
      if (p) p.done({ handled: false });
    } else if (d.zl === "guestControl" && d.op === "unregister") {
      this.terminate(origin);
    }
  }

  /** #477 wave 2: dispatch one synthetic fetch event to the running
      guest realm under the hard fail-closed budget. Every uncertain
      path (no guest, not running, no handler, malformed or oversize
      response, script error, timeout, termination) resolves
      handled:false and the engine request path serves the request
      exactly as with no guest. This seam is kernel-level and
      unit-tested; wiring it into the live request path (Zeolite SSRF,
      cookies, policy) is the next wave. */
  dispatchFetch(origin: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
    this.tick();
    const g = this.guests.get(origin);
    if (!g || g.state !== "running" || !g.guest) return Promise.resolve({ handled: false });
    const guest = g.guest;
    const id = ++this.fetchSeq;
    return new Promise<GuestFetchOutcome>((resolve) => {
      const p: { origin: string; timer: ReturnType<typeof setTimeout>; done: (o: GuestFetchOutcome) => void } = {
        origin,
        timer: null as unknown as ReturnType<typeof setTimeout>,
        done: (o: GuestFetchOutcome): void => {
          this.fetchPending.delete(id);
          clearTimeout(p.timer);
          resolve(o);
        },
      };
      p.timer = setTimeout(() => {
        DIAG.emit({
          category: "SERVICE_WORKER",
          severity: "warning",
          cause: "failure",
          message: "guest fetch budget exceeded; engine path serves the request",
          technicalReason: origin,
        });
        p.done({ handled: false });
      }, GUEST_FETCH_BUDGET_MS);
      this.fetchPending.set(id, p);
      guest.postMessage({ zl: "guestEvent", type: "fetch", data: { id, request } });
    });
  }

  /** #477 P3: route one request to the running guest whose canonical
      scope matches the request URL (the real SW fetch contract).
      Guests are keyed by origin and guestScopeMatches requires origin
      equality, so at most one record can ever match; the first match
      is exact. No match resolves handled:false and the engine request
      path serves the request exactly as with no guest. */
  dispatchFetchForUrl(url: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
    this.tick();
    for (const g of this.guests.values()) {
      if (g.state !== "running" || !g.guest) continue;
      if (guestScopeMatches(g.scope, url)) return this.dispatchFetch(g.origin, request);
    }
    return Promise.resolve({ handled: false });
  }

  /** Test and diagnostic view of live guest state. */
  active(): { origin: string; state: string }[] {
    return [...this.guests.values()].map((g) => ({ origin: g.origin, state: g.state }));
  }
}

/* Singleton wiring with the real clock. control.ts owns the spawn and
   terminate triggers via host-only control messages; zl:guestHost
   hands the port to registerHost. */
const kernel = new GuestKernel(() => Date.now());

export function guestRegisterHost(port: GuestPortLike): void {
  kernel.registerHost(port);
}

export function guestSpawn(msg: GuestSpawnMessage, reply: GuestReplyFn): void {
  kernel.spawn(msg, reply);
}

export function guestTerminate(origin: string, reply?: GuestReplyFn): void {
  kernel.terminate(origin, reply);
}

  /** #477 P3: the live request path's fetch bridge entry. Every
      uncertain outcome resolves handled:false and the ordinary engine
      request path serves the request. */
export function guestDispatchFetchForUrl(url: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
  return kernel.dispatchFetchForUrl(url, request);
}
