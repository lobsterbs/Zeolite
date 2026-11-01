/* #477 stage: guest execution over a page-created Worker realm.

   Architecture decision (2026-10-27, settles the isolation gate from
   suite/e2e/sw-capability.mjs): ServiceWorkerGlobalScope exposes no
   Worker constructor, so the engine SW cannot create any realm of its
   own. The only proven-isolated, terminable realm available is a
   DedicatedWorker created by a page context on the engine origin.
   The embedding application keeps app/guest-host.html open (the same
   pattern as the zlsw-register page) and bridges it to the SW over
   the control plane. The kernel never touches the guest realm
   directly: the host page builds the worker from a blob, transfers
   one MessagePort in, and reports spawn, error and termination back
   on the same control port.

   #538 wave (2026-10-30): the guest is no longer network-blind. A
   guest fetch() travels the guest port to the kernel, which validates
   it and executes it through the engine-side bridge wired by
   request.ts over upstreamFetch: SSRF, policy, transport decision,
   diagnostics and the cookie jar all apply, and the bridge never
   touches the SW fetch event, so a guest answer can never originate a
   guest dispatch (no recursion, by construction). waitUntil is now
   awaited under a hard budget, caches is a real per-(virtual site,
   scope) CacheStorage facade over kernel-side quota-bounded storage
   with teardown on terminate, registration.update() refetches the
   script through the same bridge and replaces the realm when the
   bytes changed, and a Clients subset exposes no enumeration.

   Honest limits, by design (docs/virtual-service-worker-phase2.md):
   guest caches are kernel-side and session-scoped (no persistence
   across engine restarts); guest fetch cookies ride the
   default-profile jar (the guest realm is not a controlled client);
   Cache API Vary handling is not modeled (entries key on the exact
   URL); clients.matchAll resolves [] (no client enumeration);
   guest postMessage reaches the kernel listener only (no delivery
   surface into virtual pages in this wave); XMLHttpRequest,
   WebSocket, importScripts and indexedDB stay shadowed; controllerchange
   and push are never dispatched; the spawn trigger is a host-only
   control message; a dead handshake is only reaped on the next kernel
   interaction. Proxied-page register capture forwards through
   control.ts (zl:guestRegister). */

import { canonicalGuestRegistration, guestScopeMatches } from "./registration";
import { DIAG } from "../../diag";

const guestKey = (origin: string, scope: string): string => origin + "\0" + scope;

/** Hard cap on the guest script body the kernel will ever wrap. */
export const GUEST_SCRIPT_MAX = 256 * 1024;
export const GUEST_REGISTRATIONS_MAX_PER_ORIGIN = 64;

/** Deadline for the host handshake of one spawn or terminate, ms. */
export const GUEST_HANDSHAKE_MS = 10000;

/** #477 wave 2: hard fail-closed budget for one synthetic guest fetch.
    A guest realm may loop or never answer; the engine never waits past
    this. */
export const GUEST_FETCH_BUDGET_MS = 250;

/** #477 wave 2: upper bound on a synthetic guest response body.
    Above it the outcome fails closed to the engine path. */
export const GUEST_FETCH_BODY_MAX = 2 * 1024 * 1024;

/** #538: hard budget for one guest-initiated network fetch through the
    engine bridge. The bridge itself has internal deadlines; this is
    the outer fail-closed bound so a wedged transport never hangs the
    guest realm's promise tracking forever. */
export const GUEST_NETFETCH_BUDGET_MS = 30000;

/** #538: hard budget for one waitUntil promise handed in by a guest.
    Exceeding it abandons the tracking (a warning is emitted); the
    guest realm keeps running, exactly like a browser giving up on an
    event whose lifetime promise never settles. */
export const GUEST_WAITUNTIL_MS = 5000;

/** #538: per-(virtual site, scope) cache quotas. The storage is
    kernel-side and per origin; these bound a single origin's share. */
export const GUEST_CACHE_MAX_CACHES = 8;
export const GUEST_CACHE_MAX_ENTRIES = 64;
export const GUEST_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const GUEST_CACHE_NAME_MAX = 128;

/** #538: methods a guest fetch may use. Everything else fails closed. */
const GUEST_NETFETCH_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

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

/** #538: the engine-side network bridge for guest fetches. request.ts
    wires this over upstreamFetch so SSRF, cookie, header, policy,
    transport and diagnostics rules all apply; the kernel never holds
    a raw transport lambda and never touches the SW fetch event. */
export type GuestNetFetchBridge = (r: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}) => Promise<{ status: number; statusText?: string; headers: Record<string, string>; body: string | null }>;

/** #538: a cached guest response entry. Bodies are plain strings;
    nothing live or privileged is stored. */
interface GuestCacheEntry {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  bytes: number;
  seq: number;
}

/** #477 wave 2: a synthetic guest response is used only when every
    field is bounded and well-typed; anything else fails closed. */
function validGuestFetchResponse(
  r: unknown,
): r is { status: number; headers?: Record<string, string>; body?: string | null } {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  if (typeof v.status !== "number" || !Number.isInteger(v.status) || v.status < 100 || v.status > 599) return false;
  if (v.headers !== undefined && v.headers !== null) {
    if (typeof v.headers !== "object" || Array.isArray(v.headers)) return false;
    for (const [k, val] of Object.entries(v.headers)) {
      if (typeof k !== "string" || typeof val !== "string") return false;
    }
  }
  if (v.body !== undefined && v.body !== null && typeof v.body !== "string") return false;
  if (typeof v.body === "string" && v.body.length > GUEST_FETCH_BODY_MAX) return false;
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
  /* #576: when true, the spawn reply is deferred until the guest
     realm confirms it is running (zl:guestSpawned), a spawn failure
     is passed through, and a dead handshake reaps as a timeout. The
     page register() promise then settles on real kernel truth. */
  confirm?: boolean;
}

export interface GuestReply {
  ok: boolean;
  error?: string;
  origin?: string;
}

type GuestReplyFn = (r: GuestReply) => void;

interface GuestRecord {
  id: number;
  origin: string;
  state: "spawning" | "running" | "terminating";
  scope: string;
  scriptURL: string;
  script: string;
  host: GuestPortLike;
  guest: GuestPortLike | null;
  deadlineAt: number;
  /* #576: deferred spawn replies for confirmed registrations; fired
     exactly once by the guestSpawned, guestSpawnFailed or reap arm.
     Same-identity callers that arrive mid-spawn piggyback here. */
  pendingReply: GuestReplyFn[];
}

export type GuestListener = (origin: string, data: unknown) => void;

/** Harness prelude prepended to the guest body. Keeps a minimal,
    honest service-worker facade and no engine surfaces: XHR,
    WebSocket, importScripts and indexedDB are shadowed, self.postMessage
    is rerouted to the engine port (a guest cannot reach the host page
    directly), and listeners are captured rather than trusted. Global overrides
    install through Object.defineProperty because a real
    WorkerGlobalScope exposes getter-only accessors (caches) that
    plain strict-mode assignment cannot shadow; a thrown override
    aborts the harness and leaves the registration facade undefined
    (real-Chromium probe, 2026-10-30). #538:
    fetch() bridges through the engine pipeline, waitUntil reports to
    the engine for bounded tracking, caches is a facade over
    kernel-side quota-bounded storage, registration.update() asks the
    engine to refetch and replace, and clients exposes no enumeration. */
export function guestHarness(scope: string, scriptURL: string): string {
  const meta = JSON.stringify({ scope, scriptURL });
  return (
    '"use strict";(function(){' +
    "var ZL=" + meta + ";" +
    "var L={},port=null,wSeq=0,nfSeq=0,nfPending={},caSeq=0,caPending={},upSeq=0,upPending={};" +
    'function post(o){if(port)port.postMessage(o);}' +
    'function def(k,v){try{Object.defineProperty(self,k,{value:v,writable:true,configurable:true});}catch(err){try{self[k]=v;}catch(e2){}}}' +
    'function serHeaders(h){var o={};if(!h)return o;if(typeof h.forEach==="function"){h.forEach(function(v,k){o[k]=String(v);});}else{Object.keys(h).forEach(function(k){o[k]=String(h[k]);});}return o;}' +
    'function mkResp(r){r=r||{};var hdrs=r.headers||{};return {ok:r.status>=200&&r.status<300,status:r.status,statusText:r.statusText||"",type:"basic",redirected:false,url:"",bodyUsed:false,' +
    'headers:{get:function(k){return hdrs[k]!==undefined?hdrs[k]:(hdrs[String(k).toLowerCase()]!==undefined?hdrs[String(k).toLowerCase()]:null);},has:function(k){return hdrs[k]!==undefined||hdrs[String(k).toLowerCase()]!==undefined;},forEach:function(fn){Object.keys(hdrs).forEach(function(k){fn(hdrs[k],k);});}},' +
    'text:function(){return Promise.resolve(r.body||"");},' +
    'json:function(){return Promise.resolve(JSON.parse(r.body||"null"));},' +
    'arrayBuffer:function(){return Promise.resolve(new TextEncoder().encode(r.body||""));},' +
    "clone:function(){return mkResp(r);}};}" +
    'function serResp(v){return Promise.resolve().then(function(){if(v&&typeof v.text==="function"){return Promise.resolve(v.text()).then(function(t){return {status:(typeof v.status==="number")?v.status:200,statusText:v.statusText||"",headers:serHeaders(v.headers),body:t};});}if(v&&typeof v==="object"&&typeof v.status==="number"){return {status:v.status,statusText:v.statusText||"",headers:serHeaders(v.headers),body:(typeof v.body==="string")?v.body:null};}throw new TypeError("a Response-like value is required");});}' +
    'function reqUrl(r){if(typeof r==="string")return r;if(r&&typeof r.url==="string")return r.url;return null;}' +
    'function caCall(op,payload){return new Promise(function(resolve,reject){var id=++caSeq;caPending[id]={res:resolve,rej:reject};post({zl:"guestCaches",id:id,op:op,payload:payload||{}});});}' +
    'function mkCache(name){return {' +
    'put:function(req,resp){var u=reqUrl(req);if(!u)throw new TypeError("cache.put needs a URL");return serResp(resp).then(function(s){return caCall("put",{name:name,url:u,entry:s}).then(function(){return undefined;});});},' +
    'match:function(req){var u=reqUrl(req);if(!u)return Promise.resolve(undefined);return caCall("match",{name:name,url:u}).then(function(hit){return hit?mkResp(hit):undefined;});},' +
    'delete:function(req){var u=reqUrl(req);if(!u)return Promise.resolve(false);return caCall("deleteEntry",{name:name,url:u}).then(function(v){return !!v;});},' +
    'keys:function(){return caCall("entries",{name:name}).then(function(v){return (v||[]).map(function(e){return e.url;});});}};}' +
    'self.addEventListener("message",function(e){' +
    'if(e.data&&e.data.zl==="harnessPort"&&e.ports&&e.ports[0]){' +
    "port=e.ports[0];port.onmessage=function(ev){" +
    'var d=ev.data;if(!d||typeof d!=="object"||typeof d.zl!=="string")return;' +
    'if(d.zl==="guestEvent"){' +
    'var f=L[d.type]||[];' +
    'if(d.type==="fetch"&&(!d.data||!f.length)){post({zl:"guestFetchNoHandler",id:d.data&&d.data.id});return;}' +
    'var g={type:d.type,data:d.data,source:null,' +
    'waitUntil:function(p){var wid=++wSeq;post({zl:"guestWait",wid:wid});Promise.resolve(p).then(function(){post({zl:"guestWaitDone",wid:wid,ok:true});},function(err){post({zl:"guestWaitDone",wid:wid,ok:false,error:String(err)});});}};' +
    'if(d.type==="fetch"&&d.data){g.request=d.data.request;' +
    'g.respondWith=function(p){Promise.resolve(p).then(function(r){if(r&&typeof r==="object"&&typeof r.text==="function"&&typeof r.status==="number"){Promise.resolve(r.text()).then(function(t){post({zl:"guestFetchResponse",id:d.data.id,response:{status:r.status,headers:serHeaders(r.headers),body:t}});},function(err){post({zl:"guestFetchResponse",id:d.data.id,error:String(err)});});}else{post({zl:"guestFetchResponse",id:d.data.id,response:r});}}).catch(function(err){post({zl:"guestFetchResponse",id:d.data.id,error:String(err)});});};}' +
    'if(d.type==="install"){R.installing={scriptURL:ZL.scriptURL,state:"installing",onstatechange:null};R.waiting=null;}' +
    'for(var i=0;i<f.length;i++){try{f[i](g);}catch(err){post({zl:"guestError",error:String(err)});}}' +
    'if(d.type==="install"){R.installing=null;R.waiting=null;}' +
    "}else if(d.zl===\"guestNetFetchResult\"){" +
    "var np=nfPending[d.id];if(np){delete nfPending[d.id];if(d.ok){np.res(mkResp(d));}else{np.rej(new Error(d.error||\"guest fetch failed\"));}}" +
    "}else if(d.zl===\"guestCachesResult\"){" +
    "var cp=caPending[d.id];if(cp){delete caPending[d.id];if(d.ok){cp.res(d.result);}else{cp.rej(new Error(d.error||\"cache operation failed\"));}}" +
    "}else if(d.zl===\"guestUpdateResult\"){" +
    "var upp=upPending[d.id];if(upp){delete upPending[d.id];if(d.ok){upp.res(true);}else{upp.rej(new Error(d.error||\"registration update failed\"));}}" +
    "}};" +
    'port.postMessage({zl:"guestReady"});}});' +
    'def("addEventListener",function(t,f){(L[t]=L[t]||[]).push(f);});' +
    'def("removeEventListener",function(t,f){var a=L[t]||[];var i=a.indexOf(f);if(i>=0)a.splice(i,1);});' +
    '["XMLHttpRequest","WebSocket","importScripts","indexedDB"].forEach(function(k){' +
    "try{Object.defineProperty(self,k,{value:undefined,configurable:true,writable:true});}catch(err){}}" +
    ");" +
    'def("postMessage",function(d){post({zl:"guestMessage",data:d});});' +
    'def("fetch",function(input,init){return new Promise(function(resolve,reject){try{' +
    'if(!port)throw new Error("guest fetch is unavailable before the realm is ready");' +
    'var url=typeof input==="string"?input:((input&&typeof input.url==="string")?input.url:String(input));' +
    'var method=((init&&init.method)||((input&&input.method)||"GET"));' +
    'var headers={};' +
    'function hset(h){if(!h)return;if(typeof h.forEach==="function"){h.forEach(function(v,k){headers[k]=String(v);});}else{Object.keys(h).forEach(function(k){headers[k]=String(h[k]);});}}' +
    "if(input&&input.headers)hset(input.headers);if(init&&init.headers)hset(init.headers);" +
    'var body=(init&&init.body!==undefined&&init.body!==null)?init.body:null;' +
    'if(body!==null&&typeof body!=="string")throw new TypeError("guest fetch supports string bodies only");' +
    "var id=++nfSeq;nfPending[id]={res:resolve,rej:reject};" +
    'post({zl:"guestNetFetch",id:id,url:url,method:String(method).toUpperCase(),headers:headers,body:body});' +
    "}catch(err){reject(err);}});});" +
    'def("caches",{' +
    'open:function(name){return caCall("open",{name:String(name)}).then(function(n){return mkCache(n);});},' +
    'has:function(name){return caCall("has",{name:String(name)}).then(function(v){return !!v;});},' +
    'keys:function(){return caCall("keys",{}).then(function(v){return v||[];});},' +
    'delete:function(name){return caCall("deleteCache",{name:String(name)}).then(function(v){return !!v;});},' +
    'match:function(req){var u=reqUrl(req);if(!u)return Promise.resolve(undefined);return caCall("storeMatch",{url:u}).then(function(hit){return hit?mkResp(hit):undefined;});}});' +
    'def("clients",{claim:function(){return Promise.resolve();},matchAll:function(){return Promise.resolve([]);},get:function(){return Promise.resolve(undefined);},openWindow:function(){return Promise.reject(new Error("clients.openWindow is unsupported in the guest harness"));}});' +
    "var R={scope:ZL.scope,scriptURL:ZL.scriptURL,updateViaCache:\"none\",installing:null,waiting:null," +
    'active:{scriptURL:ZL.scriptURL,state:"activated",onstatechange:null},' +
    'update:function(){return new Promise(function(resolve,reject){var id=++upSeq;upPending[id]={res:resolve,rej:reject};post({zl:"guestControl",op:"update",id:id});});},' +
    'unregister:function(){if(port)port.postMessage({zl:"guestControl",op:"unregister"});return Promise.resolve(false);},' +
    'getNotifications:function(){return Promise.resolve([]);}};' +
    'def("registration",R);' +
    'def("skipWaiting",function(){});' +
    "})();\n"
  );
}

export class GuestKernel {
  private hosts: GuestPortLike[] = [];
  private guests = new Map<string, GuestRecord>();
  private now: () => number;
  private onMessage: GuestListener | null = null;
  private fetchSeq = 0;
  private guestSeq = 0;
  private fetchPending = new Map<
    number,
    { key: string; timer: ReturnType<typeof setTimeout>; done: (o: GuestFetchOutcome) => void }
  >();
  /** #538: engine bridge over upstreamFetch, wired by request.ts. */
  private netFetch: GuestNetFetchBridge | null = null;
  private netPending = new Map<string, ReturnType<typeof setTimeout>>();
  /** #538: bounded waitUntil tracking, keyed origin#wid. */
  private waitPending = new Map<string, ReturnType<typeof setTimeout>>();
  /** #538: per-origin cache storage and byte accounting. */
  private cacheStores = new Map<string, Map<string, GuestCacheEntry[]>>();
  private cacheBytes = new Map<string, number>();
  private cacheSeq = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Optional sink for guest-originated messages. */
  listener(fn: GuestListener): void {
    this.onMessage = fn;
  }

  /** #538: register (or clear) the engine network bridge. */
  wireFetch(b: GuestNetFetchBridge | null): void {
    this.netFetch = b;
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
    for (const [key, g] of this.guests) {
      if (t > g.deadlineAt && g.state !== "running") {
        this.guests.delete(key);
        /* #576: confirmed callers do not hang on a dead handshake. */
        for (const pr of g.pendingReply.splice(0)) pr({ ok: false, error: "guest spawn handshake timed out" });
        DIAG.emit({
          category: "SERVICE_WORKER",
          severity: "warning",
          cause: "unknown",
          message: "guest handshake deadline exceeded; state discarded",
          technicalReason: "state " + g.state + " origin " + g.origin + " scope " + g.scope,
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
    const key = guestKey(identity.origin, identity.scope);
    const existing = this.guests.get(key);
    if (!existing && [...this.guests.values()].filter((g) => g.origin === identity.origin).length >= GUEST_REGISTRATIONS_MAX_PER_ORIGIN) {
      reply({ ok: false, error: "guest registration limit reached for this origin" });
      return;
    }
    if (existing && existing.state !== "terminating" &&
        existing.scriptURL === identity.scriptURL && existing.script === msg.script) {
      if (existing.state === "running") reply({ ok: true, origin: identity.origin });
      else if (msg.confirm === true) existing.pendingReply.push(reply);
      else reply({ ok: true, origin: identity.origin });
      return;
    }

    /* A registration is one verified virtual origin plus canonical scope.
       Re-registering replaces only that scope; sibling scopes stay active. */
    const host = existing?.host ?? this.hosts[this.hosts.length - 1];
    if (!host) {
      reply({ ok: false, error: "no guest host page connected" });
      return;
    }
    const pendingReply = existing?.pendingReply.splice(0) ?? [];
    if (msg.confirm === true) pendingReply.push(reply);
    this.clearGuestWork(key);
    const id = ++this.guestSeq;
    this.guests.set(key, {
      id,
      origin: identity.origin,
      state: "spawning",
      scope: identity.scope,
      scriptURL: identity.scriptURL,
      script: msg.script,
      host,
      guest: null,
      deadlineAt: this.now() + GUEST_HANDSHAKE_MS,
      pendingReply,
    });
    host.postMessage({
      op: "spawn",
      id,
      origin: identity.origin,
      scope: identity.scope,
      script: guestHarness(identity.scope, identity.scriptURL) + msg.script,
    });
    DIAG.emit({
      category: "SERVICE_WORKER",
      severity: "info",
      cause: "unknown",
      message: "guest spawn requested",
      technicalReason: identity.origin + " " + identity.scope,
    });
    if (msg.confirm !== true) reply({ ok: true, origin: identity.origin });
  }

  /** Host control terminates all registrations for a verified origin. */
  terminate(origin: string, reply?: GuestReplyFn): void {
    this.tick();
    const keys = [...this.guests].filter(([, g]) => g.origin === origin).map(([key]) => key);
    if (keys.length === 0) {
      if (reply) reply({ ok: false, error: "no guest for origin" });
      return;
    }
    for (const key of keys) this.terminateKey(key);
    if (reply) reply({ ok: true });
  }

  /** A page may unregister only its own exact scope and script identity. */
  unregisterScope(origin: string, scope: string, scriptURL: string, reply?: GuestReplyFn): void {
    this.tick();
    const key = guestKey(origin, scope);
    const g = this.guests.get(key);
    if (!g || g.scriptURL !== scriptURL) {
      if (reply) reply({ ok: true });
      return;
    }
    this.terminateKey(key);
    if (reply) reply({ ok: true });
  }

  private clearGuestWork(key: string): void {
    for (const [id, p] of this.fetchPending) {
      if (p.key === key) {
        this.fetchPending.delete(id);
        clearTimeout(p.timer);
        p.done({ handled: false });
      }
    }
    for (const pendingKey of [...this.waitPending.keys()]) {
      if (pendingKey.startsWith(key + "#")) {
        clearTimeout(this.waitPending.get(pendingKey) as ReturnType<typeof setTimeout>);
        this.waitPending.delete(pendingKey);
      }
    }
    for (const pendingKey of [...this.netPending.keys()]) {
      if (pendingKey.startsWith(key + "#")) {
        clearTimeout(this.netPending.get(pendingKey) as ReturnType<typeof setTimeout>);
        this.netPending.delete(pendingKey);
      }
    }
  }

  private terminateKey(key: string): boolean {
    const g = this.guests.get(key);
    if (!g) return false;
    if (g.state !== "terminating") {
      g.state = "terminating";
      g.deadlineAt = this.now() + GUEST_HANDSHAKE_MS;
      g.host.postMessage({ op: "terminate", id: g.id, origin: g.origin, scope: g.scope });
      this.clearGuestWork(key);
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        cause: "unknown",
        message: "guest termination requested",
        technicalReason: g.origin + " " + g.scope,
      });
    }
    return true;
  }

  private hostMessage(data: unknown, port: GuestPortLike): void {
    const m = data as { kind?: unknown; origin?: unknown; scope?: unknown; id?: unknown; port?: unknown; error?: unknown };
    if (!m || typeof m !== "object" || typeof m.kind !== "string") return;
    const origin = typeof m.origin === "string" ? m.origin : "";
    let key = typeof m.scope === "string" ? guestKey(origin, m.scope) : "";
    if (!key) {
      /* Older still-open host pages are accepted only when the origin has
         exactly one guest, so an ambiguous event can never cross scopes. */
      const matches = [...this.guests].filter(([, g]) => g.origin === origin);
      if (matches.length !== 1) return;
      key = matches[0][0];
    }
    const g = this.guests.get(key);
    const id = typeof m.id === "number" ? m.id : g?.id;
    if (!g || g.host !== port || g.id !== id) return;
    if (m.kind === "zl:guestSpawned") {
      const gp = m.port as GuestPortLike | undefined;
      if (g.state !== "spawning" || !gp || typeof gp.postMessage !== "function") return;
      g.guest = gp;
      g.state = "running";
      g.deadlineAt = Infinity;
      for (const pr of g.pendingReply.splice(0)) pr({ ok: true, origin });
      gp.onmessage = (ev) => this.guestMessage(key, g.id, ev.data);
      gp.postMessage({ zl: "guestEvent", type: "install" });
      gp.postMessage({ zl: "guestEvent", type: "activate" });
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        cause: "unknown",
        message: "guest running",
        technicalReason: origin + " " + g.scope,
      });
    } else if (m.kind === "zl:guestSpawnFailed") {
      if (g.state !== "spawning") return;
      this.guests.delete(key);
      const failed = "guest spawn failed: " + String(m.error ?? "unknown").slice(0, 120);
      for (const pr of g.pendingReply.splice(0)) pr({ ok: false, error: failed });
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest spawn failed",
        technicalReason: String(m.error ?? "").slice(0, 200),
      });
    } else if (m.kind === "zl:guestTerminated") {
      if (g.state !== "terminating") return;
      this.guests.delete(key);
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        cause: "unknown",
        message: "guest terminated",
        technicalReason: origin + " " + g.scope,
      });
    } else if (m.kind === "zl:guestError") {
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest worker error; terminating",
        technicalReason: typeof m.error === "string" ? m.error.slice(0, 200) : "",
      });
      this.terminateKey(key);
    }
  }

  private guestMessage(key: string, id: number, data: unknown): void {
    const g = this.guests.get(key);
    if (!g || g.id !== id || g.state !== "running") return;
    const origin = g.origin;
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
    } else if (d.zl === "guestWait" || d.zl === "guestWaitDone") {
      this.guestWait(key, d as { zl?: unknown; wid?: unknown; ok?: unknown; error?: unknown });
    } else if (d.zl === "guestNetFetch") {
      this.guestNetFetch(key, d as { id?: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown });
    } else if (d.zl === "guestCaches") {
      this.guestCaches(key, d as { id?: unknown; op?: unknown; payload?: unknown });
    } else if (d.zl === "guestControl" && d.op === "unregister") {
      this.terminateKey(key);
    } else if (d.zl === "guestControl" && d.op === "update") {
      this.guestUpdate(key, d as { id?: unknown });
    }
  }

  /** #538: bounded waitUntil. Each promise handed to waitUntil opens
      a tracker with its own hard deadline; settlement closes it. The
      engine never blocks a response on waitUntil (the response returns
      as soon as respondWith settles), but no tracker lives past the
      budget, and teardown of the realm clears every tracker. */
  private guestWait(key: string, d: { zl?: unknown; wid?: unknown; ok?: unknown; error?: unknown }): void {
    const wid = typeof d.wid === "number" ? d.wid : -1;
    if (wid < 0) return;
    const pendingKey = key + "#" + wid;
    if (d.zl === "guestWait") {
      const timer = setTimeout(() => {
        this.waitPending.delete(pendingKey);
        DIAG.emit({
          category: "SERVICE_WORKER",
          severity: "warning",
          cause: "failure",
          message: "guest waitUntil budget exceeded; tracking abandoned",
          technicalReason: "wid " + wid + " key " + key,
        });
      }, GUEST_WAITUNTIL_MS);
      this.waitPending.set(pendingKey, timer);
    } else {
      const timer = this.waitPending.get(pendingKey);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.waitPending.delete(pendingKey);
        if (d.ok !== true) {
          DIAG.emit({
            category: "SERVICE_WORKER",
            severity: "warning",
            cause: "failure",
            message: "guest waitUntil promise rejected",
            technicalReason: (typeof d.error === "string" ? d.error : "").slice(0, 200),
          });
        }
      }
    }
  }

  /** #538: a guest fetch. Everything is validated fail-closed, the
      cookie and host headers are dropped like forbidden header names
      (the engine jar owns cookies), and the engine bridge carries the
      request through upstreamFetch. The outer budget guarantees the
      guest promise tracking never hangs. */
  private guestNetFetch(
    key: string,
    d: { id?: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown },
  ): void {
    const g = this.guests.get(key);
    const id = typeof d.id === "number" ? d.id : -1;
    if (!g || !g.guest || id < 0) return;
    const guest = g.guest;
    const bad = (error: string): void => {
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest fetch refused",
        technicalReason: error.slice(0, 200),
      });
      guest.postMessage({ zl: "guestNetFetchResult", id, ok: false, error });
    };
    if (typeof d.url !== "string" || d.url.length === 0 || d.url.length > 2048) {
      bad("invalid fetch URL");
      return;
    }
    let u: URL;
    try {
      u = new URL(d.url, g.scope);
    } catch {
      bad("invalid fetch URL");
      return;
    }
    if (!/^https?:$/.test(u.protocol)) {
      bad("guest fetch supports http(s) URLs only");
      return;
    }
    const method = typeof d.method === "string" ? d.method.toUpperCase() : "";
    if (!GUEST_NETFETCH_METHODS.includes(method)) {
      bad("unsupported fetch method");
      return;
    }
    if (d.headers !== undefined && d.headers !== null && (typeof d.headers !== "object" || Array.isArray(d.headers))) {
      bad("invalid fetch headers");
      return;
    }
    const headers: Record<string, string> = {};
    if (d.headers) {
      const entries = Object.entries(d.headers as Record<string, unknown>);
      if (entries.length > 64) {
        bad("too many fetch headers");
        return;
      }
      for (const [k, v] of entries) {
        if (typeof v !== "string" || k.length > 256 || v.length > 4096) {
          bad("invalid fetch header");
          return;
        }
        const lk = k.toLowerCase();
        /* Forbidden header names never cross the guest boundary: the
           engine jar owns cookies, the transport owns the host. */
        if (lk === "cookie" || lk === "host") continue;
        headers[k] = v;
      }
    }
    if (d.body !== undefined && d.body !== null && typeof d.body !== "string") {
      bad("guest fetch supports string bodies only");
      return;
    }
    const body = typeof d.body === "string" ? d.body : null;
    if (body !== null && body.length > GUEST_FETCH_BODY_MAX) {
      bad("request body above the size cap");
      return;
    }
    if (body !== null && (method === "GET" || method === "HEAD")) {
      bad("GET or HEAD fetch cannot carry a body");
      return;
    }
    if (!this.netFetch) {
      bad("engine fetch bridge unavailable");
      return;
    }
    const pendingKey = key + "#" + id;
    const timer = setTimeout(() => {
      this.netPending.delete(pendingKey);
      bad("guest fetch budget exceeded");
    }, GUEST_NETFETCH_BUDGET_MS);
    this.netPending.set(pendingKey, timer);
    const settle = (): boolean => {
      if (!this.netPending.has(pendingKey)) return false;
      this.netPending.delete(pendingKey);
      clearTimeout(timer);
      return true;
    };
    this.netFetch({ url: u.href, method, headers, body }).then(
      (r) => {
        if (!settle()) return;
        if (
          !r ||
          typeof r !== "object" ||
          typeof r.status !== "number" ||
          r.status < 100 ||
          r.status > 599 ||
          (r.body !== null && r.body !== undefined && typeof r.body !== "string") ||
          (r.headers !== undefined && r.headers !== null && (typeof r.headers !== "object" || Array.isArray(r.headers)))
        ) {
          bad("bridge returned an invalid response");
          return;
        }
        if (typeof r.body === "string" && r.body.length > GUEST_FETCH_BODY_MAX) {
          bad("response above the size cap");
          return;
        }
        guest.postMessage({
          zl: "guestNetFetchResult",
          id,
          ok: true,
          status: r.status,
          statusText: r.statusText ?? "",
          headers: r.headers ?? {},
          body: r.body ?? null,
        });
      },
      (err) => {
        if (!settle()) return;
        bad(String(err).slice(0, 200));
      },
    );
  }

  /** #538: per-(virtual site, scope) CacheStorage ops. All storage is
      kernel-side, origin-scoped and quota-bounded; entries key on the
      canonical URL (fragment dropped) and eviction is oldest-first
      across the origin's caches. No engine cache entry is reachable:
      the namespace is private to the guest program by construction. */
  private guestCaches(key: string, d: { id?: unknown; op?: unknown; payload?: unknown }): void {
    const g = this.guests.get(key);
    const id = typeof d.id === "number" ? d.id : -1;
    if (!g || !g.guest || id < 0) return;
    const guest = g.guest;
    const origin = g.origin;
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      guest.postMessage({ zl: "guestCachesResult", id, ok, result: ok ? result : undefined, error: ok ? undefined : error });
    };
    const p = (d.payload ?? {}) as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      reply(false, undefined, "invalid cache payload");
      return;
    }
    if (typeof d.op !== "string") {
      reply(false, undefined, "invalid cache op");
      return;
    }
    const stores = this.cacheStores.get(origin) ?? new Map<string, GuestCacheEntry[]>();
    const nameOk = (n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= GUEST_CACHE_NAME_MAX;
    let url = "";
    if (typeof p.url === "string" && p.url.length > 0 && p.url.length <= 2048) {
      try {
        const cu = new URL(p.url, g.scope);
        cu.hash = "";
        url = cu.href;
      } catch {
        url = "";
      }
    }
    switch (d.op) {
      case "keys": {
        reply(true, [...stores.keys()]);
        return;
      }
      case "has": {
        if (!nameOk(p.name)) {
          reply(false, undefined, "invalid cache name");
          return;
        }
        reply(true, stores.has(p.name));
        return;
      }
      case "open": {
        if (!nameOk(p.name)) {
          reply(false, undefined, "invalid cache name");
          return;
        }
        if (!stores.has(p.name)) {
          if (stores.size >= GUEST_CACHE_MAX_CACHES) {
            DIAG.emit({
              category: "SERVICE_WORKER",
              severity: "warning",
              cause: "failure",
              message: "guest cache quota exceeded; open refused",
              technicalReason: g.origin + " " + g.scope,
            });
            reply(false, undefined, "cache quota exceeded for this site");
            return;
          }
          stores.set(p.name, []);
        }
        this.cacheStores.set(origin, stores);
        reply(true, p.name);
        return;
      }
      case "deleteCache": {
        if (!nameOk(p.name)) {
          reply(false, undefined, "invalid cache name");
          return;
        }
        const arr = stores.get(p.name);
        if (!arr) {
          reply(true, false);
          return;
        }
        let freed = 0;
        for (const e of arr) freed += e.bytes;
        stores.delete(p.name);
        this.cacheStores.set(origin, stores);
        this.cacheBytes.set(origin, Math.max(0, (this.cacheBytes.get(origin) ?? 0) - freed));
        reply(true, true);
        return;
      }
      case "put": {
        if (!nameOk(p.name)) {
          reply(false, undefined, "invalid cache name");
          return;
        }
        if (!url) {
          reply(false, undefined, "invalid cache entry URL");
          return;
        }
        const arr = stores.get(p.name);
        if (!arr) {
          reply(false, undefined, "cache is not open");
          return;
        }
        const e = p.entry as { status?: unknown; statusText?: unknown; headers?: unknown; body?: unknown } | undefined;
        if (!e || typeof e !== "object" || typeof e.status !== "number" || e.status < 100 || e.status > 599) {
          reply(false, undefined, "invalid cache entry");
          return;
        }
        if (e.body !== undefined && e.body !== null && typeof e.body !== "string") {
          reply(false, undefined, "invalid cache entry body");
          return;
        }
        const body = typeof e.body === "string" ? e.body : null;
        if (body !== null && body.length > GUEST_FETCH_BODY_MAX) {
          reply(false, undefined, "cache entry above the size cap");
          return;
        }
        let headers: Record<string, string> = {};
        if (e.headers !== undefined && e.headers !== null) {
          if (typeof e.headers !== "object" || Array.isArray(e.headers)) {
            reply(false, undefined, "invalid cache entry headers");
            return;
          }
          const ents = Object.entries(e.headers as Record<string, unknown>);
          if (ents.length > 64) {
            reply(false, undefined, "too many cache entry headers");
            return;
          }
          headers = {};
          for (const [k, v] of ents) {
            if (typeof v !== "string") {
              reply(false, undefined, "invalid cache entry header");
              return;
            }
            const lk = k.toLowerCase();
            if (lk === "set-cookie" || lk === "set-cookie2") continue;
            headers[k] = v;
          }
        }
        const statusText = typeof e.statusText === "string" ? e.statusText : "";
        const bytes = (body?.length ?? 0) + url.length + statusText.length;
        if (bytes > GUEST_FETCH_BODY_MAX + 4096) {
          reply(false, undefined, "cache entry above the origin byte quota");
          return;
        }
        /* Same-URL put replaces; the replaced entry's bytes die. */
        const at = arr.findIndex((x) => x.url === url);
        if (at >= 0) {
          const old = arr[at];
          arr.splice(at, 1);
          this.cacheBytes.set(origin, Math.max(0, (this.cacheBytes.get(origin) ?? 0) - old.bytes));
        }
        while (arr.length >= GUEST_CACHE_MAX_ENTRIES) {
          const ev = arr.shift();
          if (ev) this.cacheBytes.set(origin, Math.max(0, (this.cacheBytes.get(origin) ?? 0) - ev.bytes));
        }
        while ((this.cacheBytes.get(origin) ?? 0) + bytes > GUEST_CACHE_MAX_BYTES && arr.length > 0) {
          const ev = arr.shift();
          if (ev) this.cacheBytes.set(origin, Math.max(0, (this.cacheBytes.get(origin) ?? 0) - ev.bytes));
        }
        if ((this.cacheBytes.get(origin) ?? 0) + bytes > GUEST_CACHE_MAX_BYTES) {
          reply(false, undefined, "cache entry above the origin byte quota");
          return;
        }
        arr.push({ url, status: e.status, statusText, headers, body, bytes, seq: ++this.cacheSeq });
        this.cacheStores.set(origin, stores);
        reply(true, true);
        return;
      }
      case "match": {
        if (!nameOk(p.name) || !url) {
          reply(true, null);
          return;
        }
        const hit = (stores.get(p.name) ?? []).find((x) => x.url === url);
        reply(true, hit ? { status: hit.status, statusText: hit.statusText, headers: hit.headers, body: hit.body } : null);
        return;
      }
      case "deleteEntry": {
        if (!nameOk(p.name) || !url) {
          reply(true, false);
          return;
        }
        const arr = stores.get(p.name);
        if (!arr) {
          reply(true, false);
          return;
        }
        const at = arr.findIndex((x) => x.url === url);
        if (at < 0) {
          reply(true, false);
          return;
        }
        const [gone] = arr.splice(at, 1);
        this.cacheBytes.set(origin, Math.max(0, (this.cacheBytes.get(origin) ?? 0) - gone.bytes));
        reply(true, true);
        return;
      }
      case "entries": {
        if (!nameOk(p.name)) {
          reply(false, undefined, "invalid cache name");
          return;
        }
        reply(true, (stores.get(p.name) ?? []).map((x) => ({ url: x.url })));
        return;
      }
      case "storeMatch": {
        if (!url) {
          reply(true, null);
          return;
        }
        let hit: GuestCacheEntry | undefined;
        for (const arr of stores.values()) {
          hit = arr.find((x) => x.url === url);
          if (hit) break;
        }
        reply(true, hit ? { status: hit.status, statusText: hit.statusText, headers: hit.headers, body: hit.body } : null);
        return;
      }
      default:
        reply(false, undefined, "unsupported cache op");
    }
  }

  /** #538: registration.update(). The script is refetched through the
      engine bridge (the same policy/transport path the register
      capture used); identical bytes answer no-change, changed bytes
      resolve the caller, then terminate the old realm and spawn the
      new one over the same record, preserving the site's caches. */
  private guestUpdate(key: string, d: { id?: unknown }): void {
    const g = this.guests.get(key);
    const id = typeof d.id === "number" ? d.id : -1;
    if (!g || !g.guest || g.state !== "running" || id < 0) return;
    const guest = g.guest;
    const bad = (error: string): void => {
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "warning",
        cause: "failure",
        message: "guest registration update failed",
        technicalReason: error.slice(0, 200),
      });
      guest.postMessage({ zl: "guestUpdateResult", id, ok: false, error });
    };
    if (!this.netFetch) {
      bad("engine fetch bridge unavailable");
      return;
    }
    const pendingKey = key + "#update" + id;
    const timer = setTimeout(() => {
      this.netPending.delete(pendingKey);
      bad("update refetch budget exceeded");
    }, GUEST_NETFETCH_BUDGET_MS);
    this.netPending.set(pendingKey, timer);
    const settle = (): boolean => {
      if (!this.netPending.has(pendingKey)) return false;
      this.netPending.delete(pendingKey);
      clearTimeout(timer);
      return true;
    };
    this.netFetch({ url: g.scriptURL, method: "GET", headers: {}, body: null }).then(
      (r) => {
        if (!settle()) return;
        if (!r || typeof r !== "object" || typeof r.status !== "number") {
          bad("bridge returned an invalid response");
          return;
        }
        if (r.status !== 200) {
          bad("script refetch failed with status " + r.status);
          return;
        }
        const script = typeof r.body === "string" ? r.body : "";
        if (script === g.script) {
          guest.postMessage({ zl: "guestUpdateResult", id, ok: true, changed: false });
          return;
        }
        if (script.length === 0 || script.length > GUEST_SCRIPT_MAX) {
          bad("updated script empty or above the size cap");
          return;
        }
        /* The caller resolves before its realm is replaced; the
           replacement is deferred one tick so the port message has a
           chance to land first. */
        guest.postMessage({ zl: "guestUpdateResult", id, ok: true, changed: true });
        DIAG.emit({
          category: "SERVICE_WORKER",
          severity: "info",
          cause: "unknown",
          message: "guest script changed; replacing the realm",
          technicalReason: g.origin + " " + g.scope,
        });
        setTimeout(() => this.replaceGuest(key, script), 0);
      },
      (err) => {
        if (!settle()) return;
        bad(String(err).slice(0, 200));
      },
    );
  }

  /** #538: terminate the current realm for this origin and spawn a
      replacement with the given script over the same record. Pending
      fetches fail closed; the site's caches survive the swap. */
  private replaceGuest(key: string, script: string): void {
    const g = this.guests.get(key);
    if (!g || g.state !== "running") return;
    this.clearGuestWork(key);
    g.script = script;
    g.guest = null;
    g.id = ++this.guestSeq;
    g.state = "spawning";
    g.deadlineAt = this.now() + GUEST_HANDSHAKE_MS;
    g.host.postMessage({
      op: "spawn",
      id: g.id,
      origin: g.origin,
      scope: g.scope,
      script: guestHarness(g.scope, g.scriptURL) + script,
    });
  }

  /** #477 wave 2: dispatch one synthetic fetch event to the running
      guest realm under the hard fail-closed budget. Every uncertain
      path (no guest, not running, no handler, malformed or oversize
      response, script error, timeout, termination) resolves
      handled:false and the engine request path serves the request
      exactly as with no guest. */
  dispatchFetch(key: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
    this.tick();
    const g = this.guests.get(key);
    if (!g || g.state !== "running" || !g.guest) return Promise.resolve({ handled: false });
    const guest = g.guest;
    const id = ++this.fetchSeq;
    return new Promise<GuestFetchOutcome>((resolve) => {
      const p: { key: string; timer: ReturnType<typeof setTimeout>; done: (o: GuestFetchOutcome) => void } = {
        key,
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
          technicalReason: g.origin + " " + g.scope,
        });
        p.done({ handled: false });
      }, GUEST_FETCH_BUDGET_MS);
      this.fetchPending.set(id, p);
      guest.postMessage({ zl: "guestEvent", type: "fetch", data: { id, request } });
    });
  }

  /** Route to the most-specific running registration, matching native
      Service Worker scope selection when scopes overlap. */
  dispatchFetchForUrl(url: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
    this.tick();
    let best: GuestRecord | null = null;
    for (const g of this.guests.values()) {
      if (g.state !== "running" || !g.guest || !guestScopeMatches(g.scope, url)) continue;
      if (!best || g.scope.length > best.scope.length) best = g;
    }
    return best
      ? this.dispatchFetch(guestKey(best.origin, best.scope), request)
      : Promise.resolve({ handled: false });
  }

  /** Test and diagnostic view of live guest state. */
  active(): { origin: string; state: string }[] {
    return [...this.guests.values()].map((g) => ({ origin: g.origin, state: g.state }));
  }

  /** #538: diagnostic view of open waitUntil trackers. */
  pendingWaits(): number {
    return this.waitPending.size;
  }

  /** #538: diagnostic view of in-flight guest bridge calls. */
  pendingNetFetches(): number {
    return this.netPending.size;
  }
}

/* Singleton wiring with the real clock. control.ts owns the spawn and
   terminate triggers via host-only control messages; zl:guestHost
   hands the port to registerHost; request.ts wires the network bridge
   through guestWireFetch. */
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

export function guestUnregister(origin: string, scope: string, scriptURL: string, reply?: GuestReplyFn): void {
  kernel.unregisterScope(origin, scope, scriptURL, reply);
}

/** #538: register (or clear) the engine network bridge the kernel uses
    for guest fetches and script refetches. */
export function guestWireFetch(b: GuestNetFetchBridge | null): void {
  kernel.wireFetch(b);
}

  /** #477 P3: the live request path's fetch bridge entry. Every
      uncertain outcome resolves handled:false and the ordinary engine
      request path serves the request. */
export function guestDispatchFetchForUrl(url: string, request: GuestFetchRequest): Promise<GuestFetchOutcome> {
  return kernel.dispatchFetchForUrl(url, request);
}
