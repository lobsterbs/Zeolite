/* Runtime navigation guard + WebRTC gate (issues #28, #39).

   Cross-origin runtime DOM seams (window.open, anchor href, form
   action) would go direct and expose the client IP. This module
   rewrites those seams to engine-local NAV marker routes the SW
   decodes and proxies (#32: base64url marker, no plaintext
   destination in the DOM, address bar or history).

   Honest limits, by design:
   - location is LegacyUnforgeable; #39 closes the escape class via
     the Navigation API (cancel + re-drive through the marker). No
     window.navigation (Firefox): the meta-refresh hook covers that
     seam, the location.* limit stands. Traverse navigations cannot
     be canceled, but history only holds engine routes.
   - Parser-inserted anchors/forms fire the navigate event too;
     parser-inserted iframe src (and #58 srcdoc markup) get their
     own observer: the child has no bootstrap, so src is rewired
     before the queued load task. #116: shadow roots join through
     an attachShadow hook, and contentWindow/contentDocument reads
     install the child guard synchronously (the write-race door).
   - Engine-origin and opaque URLs pass through; relative writes on
     navigation-bound attributes re-emit through the #101
     parent-relative marker (#109). <base href> stays alone.
   - RTCPeerConnection is removed, not shimmed: WebRTC cannot be
     routed through the engine; a fake API would be dishonest.
   - #54: the marker is decodable by the page, so seams upgrade to
     minted keyed routes (zl:mint) when a microtask can be spared:
     swap rows upgrade in place, defer rows blank first then write
     the route. A refused mint falls back to the marker -
     documented degrade, never a hang. */

import { applyReemit, mintRoute } from "./mint";
import { applyCookie } from "./cookie";
import { applyIsolation } from "./isolation";
import { applyStorage } from "./storage";
import { applySenderShim } from "./postmsg";

export const NAV = "/__zl_nav__";
/* #101: parent-relative marker. A same-origin child realm (an
   about:blank iframe created by page JS) re-emits its root-relative
   fetch inputs as <parent engine route>/__zl_prel__/<encodeURIComponent(input)>;
   the SW decodes the parent route and resolves the tail against its
   destination. */
export const NAVP = "/__zl_prel__";

/* Opaque marker encoding (issue #32): the marker carries the target
   base64url-encoded - the same opacity level as every other engine
   route - so no plaintext destination appears in a DOM attribute, the
   address bar or history. Not encryption: as reversible as the /j/
   routes themselves; what it removes is the plaintext URL from every
   browser-visible surface. Local copy of the codec alphabet: the
   bootstrap bundle stays independent of codec.ts (size gate). */
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function navB64u(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    /* bytes[i] exists by the loop guard; the ?? 0 pair covers the
       final 1- and 2-byte tail (size-gate trim, logic unchanged). */
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL[n & 63];
  }
  return out;
}

/** Absolute destination URL -> engine-local marker route. The SW
    decodes the marker with the shared codec alphabet (b64uDecode). */
export function navEncode(u: string): string {
  return NAV + "/" + navB64u(u);
}

type AnyRecord = Record<string, any>;

export function applyNavGuard(
  w: Record<string, unknown>,
  loc: string,
  engineOrigin: string,
  /* #108: the guarding page's site token; when present, a
     same-origin inline child realm gets its storage/cookie
     surfaces scoped to the parent's site. */
  site?: string,
): void {
  /* Absolute cross-origin http(s) destination, or null: relative,
     opaque, engine-local and already-routed values are no mint
     business (#54). */
  const destAbs = (v: string): string | null => {
    let u: URL;
    try {
      u = new URL(String(v), loc);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin === engineOrigin) return null;
    return u.href;
  };
  /* The synchronous fallback every mint failure degrades to. */
  const rewire = (v: string): string => {
    const d = destAbs(v);
    return d === null ? String(v) : navEncode(d);
  };
  /* #109: a relative write to a navigation-bound attribute
     resolves against the page's own engine route, so destAbs
     returns null and the raw value reached the browser - the
     navigation then landed on the proxy origin. Re-emit through
     the #101 parent-relative marker instead: the SW decodes the
     own route and resolves the tail against its destination,
     navigations included. Excluded: engine-route-shaped paths
     (the own prefix), engine surfaces (the markers, bootstrap,
     /zlsw, /libcurl, /zl-), scheme and protocol-relative inputs,
     fragments and empty values; without a route-shaped own URL
     (an about:blank child) nothing changes. */
  let ownRoutePath: string | undefined;
  try {
    ownRoutePath = new URL(loc).pathname;
  } catch {
    /* a realm whose loc is not a URL anchors nothing */
  }
  const engPrefix = ownRoutePath?.match(/^\/[^/]+\//)?.[0];
  const navRel = (v: string): string | null => {
    if (
      !ownRoutePath ||
      !engPrefix ||
      !v ||
      v.startsWith(engPrefix) ||
      v[0] === "#" ||
      v.startsWith("//") ||
      v.startsWith("/__zl_") ||
      v === "/bootstrap.js" ||
      v.startsWith("/zlsw") ||
      v.startsWith("/libcurl") ||
      v.startsWith("/zl-") ||
      /^[a-z][a-z0-9+.-]*:/i.test(v)
    )
      return null;
    return ownRoutePath + NAVP + "/" + encodeURIComponent(v);
  };
  /* Reads must return what the page wrote: frameworks compare href
     values, so the raw string is kept per element and attribute and
     the marker only reaches the browser. Keyed by name since #58:
     an iframe now guards src and srcdoc on the same element. */
  const raw = new WeakMap<object, Record<string, string>>();
  /* Guard transforms receive the element: the meta hook needs it for
     its http-equiv check; the srcdoc hook rewrites markup. #54
     modes: "sync" rows transform synchronously (srcdoc/meta
     markup); "swap" rows write the marker immediately and upgrade
     to the minted route when the mint lands (read-heavy hrefs must
     never be blank); "defer" rows write a blank immediately - the
     load task starts after this task - and the minted route (marker
     fallback) lands next. A newer write always wins. */
  type Mode = "sync" | "swap" | "defer";
  const mintUp = (
    el: AnyRecord,
    key: string,
    wrote: string,
    dest: string,
    write: (v: string) => void,
  ): void => {
    mintRoute(dest).then((route) => {
      if (raw.get(el)?.[key] !== wrote) return;
      try {
        write(route ?? navEncode(dest));
      } catch {
        /* a newer write owns the element */
      }
    });
  };
  const guardProp = (
    proto: AnyRecord,
    prop: string,
    mode: Mode,
    nav: boolean,
    xf?: (el: AnyRecord, v: string) => string,
  ): void => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: true,
      get(this: AnyRecord) {
        return raw.get(this)?.[prop] ?? d.get!.call(this);
      },
      set(this: AnyRecord, v: string) {
        const s = String(v);
        const m = raw.get(this);
        if (m) m[prop] = s;
        else raw.set(this, { [prop]: s });
        if (xf) {
          d.set!.call(this, xf(this, s));
          return;
        }
        const dest = destAbs(s);
        if (dest === null) {
          d.set!.call(this, nav ? navRel(s) ?? s : s);
          return;
        }
        if (mode === "defer") d.set!.call(this, "");
        else d.set!.call(this, navEncode(dest));
        mintUp(this, prop, s, dest, (r) => d.set!.call(this, r));
      },
    });
  };
  const guardAttr = (
    proto: AnyRecord,
    attr: string,
    mode: Mode,
    nav: boolean,
    xf?: (el: AnyRecord, v: string) => string,
  ): void => {
    const O = proto.setAttribute;
    if (typeof O !== "function") return;
    /* #59: DOM attribute names are case-insensitive (HREF sets
       href), so the compare lowercases; the page-truthful raw string
       is stored so property reads return what the page wrote. */
    proto.setAttribute = function (this: AnyRecord, n: string, v: string) {
      const hit = String(n).toLowerCase() === attr;
      if (!hit) return O.call(this, n, v);
      const s = String(v);
      const m = raw.get(this);
      if (m) m[attr] = s;
      else raw.set(this, { [attr]: s });
      if (xf) return O.call(this, n, xf(this, s));
      const dest = destAbs(s);
      if (dest === null) return O.call(this, n, nav ? navRel(s) ?? s : s);
      if (mode === "defer") O.call(this, n, "");
      else O.call(this, n, navEncode(dest));
      mintUp(this, attr, s, dest, (r) => O.call(this, n, r));
    };
  };
  /* A read-only prototype must not abort the remaining hooks. */
  const safe = (f: () => void) => {
    try {
      f();
    } catch {
      /* hook stays native */
    }
  };
  /* The navigate re-drive below resubmits a canceled form through a
     synthetic form: its action must be written with the PRE-hook
     setAttribute, or the defer hook on form action would blank the
     action and the POST would go to the current document (#54). */
  const FORM_PROTO = w.HTMLFormElement as AnyRecord | undefined;
  const FORM_SET = FORM_PROTO
    ? (FORM_PROTO.prototype.setAttribute as (
        this: AnyRecord,
        n: string,
        v: string,
      ) => void)
    : undefined;
  /* swap rows: hrefs are read by page code, never blanked.
     defer rows: writes that trigger loads are blanked first; the
     minted route lands before the load task. nav rows (#109):
     navigation-bound attributes whose relative writes would land
     on the proxy origin re-emit through the #101 parent-relative
     marker; link href stays raw (a subresource, the SW's own
     relative-path recovery reroutes it). */
  const table: Array<[AnyRecord | undefined, string, "swap" | "defer", boolean]> = [
    [w.HTMLAnchorElement as AnyRecord, "href", "swap", true],
    [w.HTMLAreaElement as AnyRecord, "href", "swap", true],
    [w.HTMLIFrameElement as AnyRecord, "src", "defer", true],
    [w.HTMLFormElement as AnyRecord, "action", "defer", true],
    [w.HTMLLinkElement as AnyRecord, "href", "defer", false],
  ];
  for (const [C, prop, mode, nav] of table) {
    if (!C) continue;
    const proto = C.prototype;
    safe(() => guardProp(proto, prop, mode, nav));
    safe(() => guardAttr(proto, prop, mode, nav));
  }
  /* #58: srcdoc gives the frame an inline child document that runs
     no bootstrap (about:srcdoc is not an engine destination), so
     absolute URLs inside its markup would load browser-direct from
     the child. Rewire the navigable attributes inside the markup:
     the child's initial navigations then ride the marker route,
     which the parent's SW proxies like any engine route. #116
     residual 3: unquoted values end at the first whitespace, so the
     URL inside them carries no spaces and rewrites safely; quoted
     values keep their quotes. */
  const rewireSrcdoc = (v: string): string =>
    v.replace(
      /(\s(?:href|src|action|formaction|poster|background|cite|data)\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi,
      (_m: string, p: string, val: string) => {
        if (val.length > 1 && (val[0] === '"' || val[0] === "'"))
          return p + val[0] + rewire(val.slice(1, -1)) + val[0];
        return p + rewire(val);
      },
    );
  const IFR = w.HTMLIFrameElement as AnyRecord | undefined;
  if (IFR) {
    safe(() => guardProp(IFR.prototype, "srcdoc", "sync", false, (_el, v) => rewireSrcdoc(v)));
    safe(() => guardAttr(IFR.prototype, "srcdoc", "sync", false, (_el, v) => rewireSrcdoc(v)));
    /* #116 residual 4: a child script can run in the same task that
       created it (contentDocument.write), before the observer
       microtask lands the child guard - the navigation it commits
       is browser-direct and uncatchable. Every path into the child
       realm reads contentWindow or contentDocument first, so both
       getters install the child guard synchronously at access
       time; the shared flag keeps guardChild's own reads from
       recursing through the getters. */
    let ing = false;
    for (const prop of ["contentWindow", "contentDocument"]) {
      safe(() => {
        const d = Object.getOwnPropertyDescriptor(IFR.prototype, prop);
        if (!d || !d.get) return;
        Object.defineProperty(IFR.prototype, prop, {
          configurable: true,
          enumerable: true,
          get(this: AnyRecord) {
            if (!ing) {
              ing = true;
              try {
                guardChild(this);
              } finally {
                ing = false;
              }
            }
            return d.get!.call(this);
          },
        });
      });
    }
  }
  /* #39 residual: runtime-injected meta refresh is the one navigation
     seam left on engines without the Navigation API (Firefox has no
     window.navigation, so the cancel-and-re-drive seam never fires).
     Rewires the url token of http-equiv=refresh content values; only
     refresh metas are touched, so viewport, CSP and og:* content pass
     through byte-identical. Parser-inserted meta keeps its limit
     honestly: that markup belongs to the static rewriter. */
  const META = w.HTMLMetaElement as AnyRecord | undefined;
  if (META) {
    const rewireMeta = (el: AnyRecord, v: string): string =>
      String(el.httpEquiv ?? "").toLowerCase() === "refresh"
        ? v.replace(
            /(url\s*=\s*)(["']?)([^"']*)\2/i,
            (_m: string, p: string, q: string, u: string) => p + q + rewire(u) + q,
          )
        : v;
    safe(() => guardProp(META.prototype, "content", "sync", false, rewireMeta));
    safe(() => guardAttr(META.prototype, "content", "sync", false, rewireMeta));
  }
  /* Runtime-set SRI (#77 runtime half): the browser hashes the body
     the SW returns - the rewritten one - so a runtime integrity write
     fails the load as a network error. Swallow the write on script
     and link elements; reads stay page-truthful so feature-detecting
     code still sees its own value. innerHTML-injected markup and
     Request objects keep SRI (documented residuals). */
  const sriGuard = (C: AnyRecord | undefined): void => {
    const proto = C && C.prototype;
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, "integrity");
    if (d && d.set && d.get) {
      Object.defineProperty(proto, "integrity", {
        configurable: true,
        enumerable: true,
        get(this: AnyRecord) {
          return raw.get(this)?.["integrity"] ?? d.get!.call(this);
        },
        set(this: AnyRecord, v: string) {
          const s = String(v);
          const m = raw.get(this);
          if (m) m["integrity"] = s;
          else raw.set(this, { integrity: s });
        },
      });
    }
    const O = proto.setAttribute;
    if (typeof O !== "function") return;
    proto.setAttribute = function (this: AnyRecord, n: string, v: string) {
      if (String(n).toLowerCase() !== "integrity") return O.call(this, n, v);
      const s = String(v);
      const m = raw.get(this);
      if (m) m["integrity"] = s;
      else raw.set(this, { integrity: s });
    };
  };
  safe(() => sriGuard(w.HTMLScriptElement as AnyRecord | undefined));
  safe(() => sriGuard(w.HTMLLinkElement as AnyRecord | undefined));

  const OW = w.open;
  if (typeof OW === "function") {
    safe(() => {
      w.open = function (this: AnyRecord, u?: string | URL, t?: string, f?: string) {
        const s = u == null ? undefined : typeof u === "string" ? u : u.href;
        if (s == null) return (OW as AnyRecord).call(this, u, t, f);
        const d = destAbs(s);
        if (!d) return (OW as AnyRecord).call(this, rewire(s), t, f);
        /* #54: open the popup on a blank engine-origin document,
           then drive it to the minted route - the plaintext target
           never reaches the popup request. A closed popup stays
           blank (contained). */
        const win = (OW as AnyRecord).call(this, "", t, f) as AnyRecord | null;
        mintRoute(d).then((route) => {
          try {
            const l = win && (win as { location?: unknown }).location;
            if (l) (l as { href: string }).href = route ?? navEncode(d);
          } catch {
            /* a closed popup cannot be driven */
          }
        });
        return win;
      };
    });
  }
  /* #106: a popup-class activation - a target=_blank anchor, or any
     click the browser upgrades to a new top-level context (middle
     button, ctrl/meta/shift modifier) - fires no navigate event in
     this document: the navigation belongs to the new context, which
     has no guard yet. A raw-destination anchor (innerHTML or
     document.write markup: the property and setAttribute hooks
     never saw it) therefore opened unproxied, plaintext destination
     and all. A capture-phase click/auxclick listener sees the
     activation before any page handler relies on it and cancels
     it. #109: the popup class re-opens through the ORIGINAL
     window.open synchronously, while the activation's transient
     user activation is still live - the minted re-drive landed
     past the activation window on heavy pages, so the popup was
     blocked and the button only visibly pressed. The opaque NAV
     marker route rides this path directly (no mint); _top/_parent
     are driven through the ancestor window itself after the mint
     (engine frames are same-origin, so the ancestor's own guard
     owns the follow-up; a location write needs no activation).
     Engine-route anchors of every target already load through the
     SW scope and stay native; same-window plain clicks stay native
     too: the navigate seam owns them. */
  const AE = w.addEventListener as
    | ((t: string, fn: (e: Event) => void, c?: boolean) => void)
    | undefined;
  if (typeof AE === "function") {
    /* click and auxclick both fire for a middle activation: the
       anchor is marked so the pair drives one popup, and unmarked
       after the task (popup path) or when the drive lands. */
    const driven = new WeakSet<object>();
    const drivePopup = (ev: Event): void => {
      const e = ev as MouseEvent;
      if (e.defaultPrevented) return;
      const btn = e.button ?? 0;
      if (btn !== 0 && btn !== 1) return;
      let n = e.target as AnyRecord | null;
      while (n && String(n.tagName ?? "").toUpperCase() !== "A")
        n = (n.parentNode as AnyRecord | null) ?? null;
      if (!n) return;
      const href = String(n.href ?? "");
      if (!href) return;
      const tgt = String(n.target ?? "").toLowerCase();
      const popup =
        tgt === "_blank" || btn === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
      if (!popup && tgt !== "_top" && tgt !== "_parent") return;
      const d = destAbs(href);
      if (d === null) return;
      /* canceled in capture phase: nothing browser-direct is ever
         requested; the mint delay is paid before the first byte of
         the replacement navigation, the same contract as the
         navigate re-drive. */
      ev.preventDefault();
      if (driven.has(n)) return;
      driven.add(n);
      if (popup) {
        /* #109: the re-open must ride the activation window, so it
           goes through the captured original open with the marker
           route (engine-local, SW-scoped), the target's popup name
           (_blank only: a modifier activation ignores the anchor's
           own target, like the native new-tab behavior) and the
           rel-derived noopener feature. No mint on this path. The
           driven mark clears on a timeout: click and auxclick of
           one middle activation dispatch inside this task, so one
           press opens one popup and a later press opens again. */
        const rel = String(n.rel ?? "");
        const keepOpener = /(^|\s)opener(\s|$)/i.test(rel);
        const feats = keepOpener ? "" : /no(open|referr)er/i.test(rel) || tgt === "_blank" ? "noopener" : "";
        const name = tgt === "_blank" ? "_blank" : "";
        if (typeof OW === "function") {
          try {
            (OW as AnyRecord).call(w, navEncode(d), name, feats);
          } catch {
            /* a window that refuses the popup stays contained */
          }
        }
        setTimeout(() => driven.delete(n));
        return;
      }
      mintRoute(d).then((route) => {
        const r = route ?? navEncode(d);
        try {
          driven.delete(n);
          const tw =
            tgt === "_top"
              ? (w.top as AnyRecord | undefined)
              : tgt === "_parent"
                ? (w.parent as AnyRecord | undefined)
                : w;
          const l = tw && (tw.location as { href: string } | undefined);
          if (l) l.href = r;
        } catch {
          /* a closed or cross-origin window cannot be driven */
        }
      });
    };
    safe(() => AE.call(w, "click", drivePopup, true));
    safe(() => AE.call(w, "auxclick", drivePopup, true));
  }
  /* #58 follow-up: an inline child document (about:srcdoc,
     about:blank, a same-origin child that never fetched an engine
     document) runs no bootstrap of its own, so a runtime navigation
     inside it - a docwrite'd meta refresh, a location assignment -
     fires in the CHILD realm, where no listener or hook exists, and
     commits browser-direct. A real-URL subframe navigation is
     exactly what a browser URL-block policy evaluates, so the
     child realm gets the guard itself: applyNavGuard re-enters on
     the child window, and the child's own observer then guards
     grandchildren, recursively. The element's load event re-runs
     the hook because a srcdoc or src swap replaces the document.
     Cross-origin and sandboxed children throw on the realm probe
     and stay browser-direct on purpose (challenge hosts must stay
     native), and a realm whose bootstrap already ran (window.__ZL)
     owns its own guard. A twice-guarded realm is safe: rewire is
     idempotent on marker routes and the navigate listener honors
     defaultPrevented. */
  const guardedDocs = new WeakSet<object>();
  const loadHooked = new WeakSet<object>();
  const guardChild = (el: AnyRecord): void => {
    if (typeof el.addEventListener !== "function") return;
    if (!loadHooked.has(el)) {
      loadHooked.add(el);
      try {
        el.addEventListener("load", () => guardChild(el));
      } catch {
        /* an element that refuses listeners keeps its native load */
      }
    }
    const win = el.contentWindow as AnyRecord | undefined;
    let doc: AnyRecord | undefined;
    try {
      doc = el.contentDocument as AnyRecord | undefined;
    } catch {
      return;
    }
    if (!win || !doc || guardedDocs.has(doc)) return;
    try {
      if (win.__ZL) return;
    } catch {
      return; /* cross-origin window: any property access throws */
    }
    guardedDocs.add(doc);
    try {
      applyNavGuard(win, String(doc.baseURI ?? loc), engineOrigin);
      /* #101: the child realm gets the reemit patch too, anchored to
         the guarding page's engine route path, so its root-relative
         fetch/XHR/beacon inputs re-emit as parent-relative marker
         routes instead of escaping to the proxy origin. A realm
         guarded from an about:blank parent passes no path: its own
         loc is not a route, so the grandchild keeps the honest
         native degrade. */
      let routePath: string | undefined;
      try {
        /* the pathname carries no validation of its own: relRoute's
           engine-prefix check rejects non-route pages (an
           about:blank parent), an empty path anchors nothing. */
        routePath = new URL(loc).pathname;
      } catch {
        /* not a URL: no parent route to anchor to */
      }
      applyReemit(win, routePath);
      /* #131: the guarded child realm also gets the sender-side
         identity repair, so its parent.postMessage calls deliver
         with its own window as ev.source. */
      applySenderShim(win);
      /* #108: a same-origin inline child (about:blank, about:srcdoc)
         inherits the proxy origin, so its native document.cookie,
         cookieStore and localStorage are the real engine-origin
         surfaces: left native, a child write lands in the real
         proxy-origin jar. The guarding page's site token scopes the
         child's surfaces exactly like its own (the cookie channel
         rides the parent's controller, so child writes stay in the
         parent's virtual jar). A guard without a site (an
         unrewritten parent) keeps the native degrade. */
      if (site) {
        const CP = "zl:" + site + ":";
        const cst = applyStorage(win, CP);
        applyIsolation(win, CP, cst);
        applyCookie(site, (doc as unknown) as Document);
      }
    } catch {
      /* a realm that refuses hooks stays native */
    }
  };
  /* #39: the Navigation API is the one seam the LegacyUnforgeable
     location sinks ever had. The navigate event fires in this
     document for every cross-document navigation it initiates -
     location.href/assign/replace, anchor and form activations,
     runtime-injected meta refresh - and is cancelable for
     push/replace/reload types (never traverse; browser-UI
     navigations do not fire it here). Cancel the real-origin
     navigation and re-drive through the marker so the browser
     stays inside the SW scope. A canceled form POST is resubmitted
     with its entries - urlencoded only, multipart degrades - rather
     than silently becoming a GET. */
  const nav = w.navigation as
    | { addEventListener(t: string, fn: (e: unknown) => void): void }
    | undefined;
  if (nav && typeof nav.addEventListener === "function") {
    safe(() =>
      nav.addEventListener("navigate", (e) => {
        const ev = e as {
          cancelable?: boolean;
          defaultPrevented?: boolean;
          destination?: { url?: string; sameDocument?: boolean };
          formData?: FormData | null;
          preventDefault(): void;
        };
        if (!ev.cancelable || ev.destination?.sameDocument) return;
        /* a second listener in a twice-guarded realm must not
           cancel-and-re-drive a navigation the first already did */
        if (ev.defaultPrevented) return;
        const dest = destAbs(String(ev.destination?.url ?? ""));
        if (dest === null) return;
        ev.preventDefault();
        /* #54: re-drive through the minted route (marker fallback);
           the cancel already happened, so the mint delay is paid
           before the first byte of the navigation. */
        mintRoute(dest).then((route) => {
          const target = route ?? navEncode(dest);
          if (!ev.formData) {
            (w.location as { href: string }).href = target;
            return;
          }
          const f = (w.document as Document).createElement("form") as HTMLFormElement;
          f.method = "POST";
          /* the synthetic form's action goes through the PRE-hook
             setAttribute: the defer hook on form action would blank
             the action and the POST would go to the current
             document (#54). */
          if (FORM_SET) FORM_SET.call(f, "action", target);
          else f.action = target;
          f.style.display = "none";
          /* HTMLFormElement has no field-append: the previous
             f.append(k, v) resolved to Element.append, which injects
             text nodes instead of entries (CI tsc caught it, TS2345).
             Hidden inputs carry the urlencoded entries; File values
             degrade to their name, as the header comment admits. */
          for (const [k, v] of (ev.formData as FormData).entries()) {
            const i = (w.document as Document).createElement("input") as HTMLInputElement;
            i.type = "hidden";
            i.name = k;
            i.value = typeof v === "string" ? v : v.name;
            f.appendChild(i);
          }
          (w.document as Document).body.appendChild(f);
          f.submit();
          f.remove();
        });
      }),
    );
  }
  /* A form whose action was set through a bypassing path can still be
     submitted programmatically: rewrite the action attribute in place
     first (the marker stores like any engine route). */
  const F = w.HTMLFormElement as AnyRecord;
  if (F) {
    for (const m of ["submit", "requestSubmit"]) {
      const O = F.prototype[m];
      if (typeof O !== "function") continue;
      safe(() => {
        F.prototype[m] = function (this: AnyRecord) {
          const a = String(this.action);
          const r = rewire(a);
          if (r !== a) this.setAttribute("action", r);
          return O.apply(this, arguments);
        };
      });
    }
  }
  /* #32/#35: document.referrer of the proxied frame is the embedder
     URL (the browser stamps it from the embed navigation), so it
     carries the plaintext ?url= destination onto a page surface - the
     browser E2E caught it. Override the DOM surface to the empty
     string; the wire Referer for subresources is re-stamped by the
     engine from the real destination, so referrer-based fallbacks
     upstream keep working. A sealed document stays native (safe). */
  const D = w.document as Document | undefined;
  if (D) safe(() => Object.defineProperty(D, "referrer", { get: () => "", configurable: true }));
  /* Parser-inserted iframe/frame src (innerHTML, document.write):
     neither hook above ran, so a src naming a real origin would load
     the child frame DIRECTLY - outside the engine, invisible to the
     navigate seam (the child has no bootstrap yet). A document-wide
     MutationObserver rewires it to the marker before the browser's
     queued iframe load task starts: an observer callback is a
     microtask, the load is a task, so the child never receives the
     plaintext address. Added subtrees are scanned whole (innerHTML
     adds one root, not one record per frame). #116 residual 2:
     shadow roots created after this guard join through the
     attachShadow hook below; roots older than the guard keep
     their native frame loads (documented at the hook). */
  const MO = w.MutationObserver as
    | (new (cb: (muts: Array<{ type: string; addedNodes: ArrayLike<AnyRecord> }>) => void) => {
        observe(t: AnyRecord, o: AnyRecord): void;
      })
    | undefined;
  if (D && MO && D.documentElement) {
    const rewired = (el: AnyRecord): void => {
      const tag = String(el.tagName ?? "").toUpperCase();
      if (tag !== "IFRAME" && tag !== "FRAME") return;
      const attr = (n: string, xf: (s: string) => string): void => {
        const s = typeof el.getAttribute === "function" ? el.getAttribute(n) : null;
        if (typeof s !== "string" || !s) return;
        const r = xf(s);
        if (r !== s && typeof el.setAttribute === "function") el.setAttribute(n, r);
      };
      /* #54: a parser-inserted cross-origin src is blanked inside
         the observer microtask (the load task starts after it) and
         the minted route lands next; the marker stays the fallback,
         and a newer src write cancels the upgrade. */
      {
        const s0 = typeof el.getAttribute === "function" ? el.getAttribute("src") : null;
        if (typeof s0 === "string" && s0 && typeof el.setAttribute === "function") {
          const d = destAbs(s0);
          if (d !== null) {
            el.setAttribute("src", "");
            mintRoute(d).then((route) => {
              try {
                if (el.getAttribute("src") === "") el.setAttribute("src", route ?? navEncode(d));
              } catch {
                /* the frame left the DOM */
              }
            });
          }
        }
      }
      /* #58: a parser-inserted srcdoc child document runs no
         bootstrap either; its markup rides the same observer. */
      if (tag === "IFRAME") attr("srcdoc", rewireSrcdoc);
      /* every frame the observer reaches gets its child realm
         guarded: the child runs no bootstrap of its own. */
      guardChild(el);
    };
    const scan = (n: AnyRecord): void => {
      if (!n || n.nodeType !== 1) return;
      rewired(n);
      if (typeof n.querySelectorAll === "function") {
        const frames = n.querySelectorAll("iframe,frame") as ArrayLike<AnyRecord>;
        for (let i = 0; i < frames.length; i++) rewired(frames[i]);
      }
    };
    let obs: { observe(t: AnyRecord, o: AnyRecord): void } | null = null;
    safe(() => {
      obs = new MO((muts) => {
        for (const m of muts) {
          if (m.type !== "childList") continue;
          for (let i = 0; i < m.addedNodes.length; i++) scan(m.addedNodes[i]);
        }
      });
      obs.observe(D.documentElement as unknown as AnyRecord, { childList: true, subtree: true });
    });
    /* #116 residual 2: frames inside a shadow root escape a
       document-wide observer, so parser-inserted shadow frames
       loaded browser-direct. Hook attachShadow: every created root
       is observed with the same contract (rewire + child guard)
       by this guard's own observer. The __zlShadow flag keeps a
       twice-guarded realm from stacking a second hook over the
       first. */
    const ES = w.Element as AnyRecord | undefined;
    const OAS = ES && ES.prototype && ES.prototype.attachShadow;
    if (typeof OAS === "function" && !(OAS as AnyRecord).__zlShadow) {
      safe(() => {
        (ES as AnyRecord).prototype.attachShadow = function (this: AnyRecord, init: AnyRecord) {
          const root = OAS.call(this, init);
          if (root) obs?.observe(root, { childList: true, subtree: true });
          return root;
        };
        ((ES as AnyRecord).prototype.attachShadow as AnyRecord).__zlShadow = true;
      });
    }
    /* Frames already in the DOM when this realm is guarded (a child
       realm guarded on load): the observer only sees later
       additions, so give the present ones their realm guard.
       Frames inside shadow roots created before this guard ran
       keep their native loads: the hook above only covers roots
       created after it (a documented residual). */
    if (typeof D.querySelectorAll === "function") {
      const frames = D.querySelectorAll("iframe,frame") as ArrayLike<AnyRecord>;
      for (let i = 0; i < frames.length; i++) guardChild(frames[i]);
    }
  }
  /* WebRTC connects directly; presence would be a fake feature. */
  delete w.RTCPeerConnection;
}
