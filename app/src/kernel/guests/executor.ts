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
   (caches, indexedDB shadowed), get no fetch events, controllerchange
   and push are never dispatched, waitUntil is accepted and not
   awaited, the spawn trigger is a host-only control message, and a
   dead handshake is only reaped on the next kernel interaction (no
   timer inside the kernel). Proxied-page register capture stays
   virtual-only in this wave. */

import { canonicalGuestRegistration } from "./registration";
import { DIAG } from "../../diag";

/** Hard cap on the guest script body the kernel will ever wrap. */
export const GUEST_SCRIPT_MAX = 256 * 1024;

/** Deadline for the host handshake of one spawn or terminate, ms. */
export const GUEST_HANDSHAKE_MS = 10000;

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
    "var f=L[d.type]||[];var g={type:d.type,data:d.data,source:null,waitUntil:function(){}};" +
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
    } else if (d.zl === "guestControl" && d.op === "unregister") {
      this.terminate(origin);
    }
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
