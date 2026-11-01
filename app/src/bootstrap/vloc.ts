/* Virtual location (#236, paired with the #235 AST rename).

   Pathname-routed SPAs (SvelteKit-class client routers) match
   their route tables against location.pathname, which the
   engine replaced with the opaque route; every in-app route
   match failed and each navigation degraded to a full document
   load (the wave-25 Brave Ask entry). window.location is
   LegacyUnforgeable, so no runtime hook can change what the
   native location reads return; #235 renames location reads in
   page JS to __zl, and this module installs __zl as a
   location-like view over the REAL path:

   - pathname/search/hash come from virtual state seeded by the
     injected __ZL.vpath (the destination path without any
     host, the same #144 relaxation that makes NAVH handle URLs
     carry the real path visibly: the host stays opaque), or
     parsed back off the native NAVH/NAVP route URL.
   - origin/protocol/host stay the native engine values, so
     origin-derived re-emits keep the #157 own-origin anchor.
   - history.pushState/replaceState re-anchor the virtual path
     through the entry route as <entry>/__zl_prel__/<encoded
     path>, the #101 parent-relative marker the SW decodes:
     history entries stay engine-local and a reload of any of
     them deep-links straight back to the same virtual path
     (deep-link restore by construction, no extra state).
   - popstate/hashchange re-parse the virtual path off the
     native URL, registered before any page listener can be, so
     page popstate handlers always read the updated view.
   - assign/replace/reload (and href writes) drive the native
     location with the re-anchored route; a cross-origin or
     opaque value passes through natively and the navguard
     navigate seam owns that class.
   - hash/search/pathname member writes carry view setters
     (#182): hash mirrors natively (a real history entry and
     hashchange stay real), search/pathname re-anchor and
     navigate like assign.

   Honest limits: bare top/parent reads stay native (#235 keeps
   frame-buster identity), so top.location still exposes the
   opaque route to comparisons; writes to location itself stay
   native for the same reason. Without an entry route (an
   engine-origin root document) nothing installs. */

import { NAVP } from "./navguard";
import { NativeURL } from "./anchorshim";

/* Local copy of the handle marker: the bootstrap bundle stays
   independent of codec.ts (size gate), same as navguard's NAV. */
const NAVH = "/__zl_navh__";

/* Local copy of the query-route param (Injector phase 2), same
   lockstep rule: keep in step with codec.NAVQ_PARAM. */
const NAVQ = "zlNavh";

/* #410: lockstep copies of the codec's leading-slash escape/restore
   (the bootstrap bundle stays independent of codec.ts, same rule as
   the NAVH/NAVQ markers above). */
const escapeLeading = (p: string): string =>
  p.replace(/^(\/)(\/+)/, (_s: string, one: string, rest: string) => one + "%2F".repeat(rest.length));
const restoreLeading = (p: string): string =>
  p.replace(/^\/((?:%2F)+)/, (_all: string, run: string) => "/" + "/".repeat(run.length / 3));

/* search -> [token, cleanedSearch] with the token component removed
   (raw, byte-faithful; the first param wins, mirroring the codec's
   order). Null = no param. The page realm cannot MAC-verify the
   token; it only carries it, and the SW fails impostors closed. */
function navqStrip(search: string): [string, string] | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return null;
  const parts = raw.split("&");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(NAVQ + "=")) {
      const rest = parts.slice(0, i).concat(parts.slice(i + 1));
      return [parts[i].slice(NAVQ.length + 1), rest.length > 0 ? "?" + rest.join("&") : ""];
    }
  }
  return null;
}

/* #107 phase 2: consumers (embedsync) subscribe to virtual-path
   changes. Module-level so applyVloc can run before the consumer
   registers; the hook must never break the location view. */
let vlocHook: ((virt: string) => void) | null = null;

export function onVlocChange(cb: (virt: string) => void): void {
  vlocHook = cb;
}

const moved = (v: string): void => {
  try {
    if (vlocHook) vlocHook(v);
  } catch {
    /* a consumer hook must never break the location view */
  }
};

type NativeLoc = {
  href: string;
  origin: string;
  hash: string;
  assign(u: string): void;
  replace(u: string): void;
  reload(): void;
};
type Hist = {
  pushState(s: unknown, t: string, u?: string | null): void;
  replaceState(s: unknown, t: string, u?: string | null): void;
};

export function applyVloc(w: Record<string, unknown>, vpath?: string): void {
  const nat = w.location as NativeLoc | undefined;
  if (!nat || w.__zl) return;
  const hist = w.history as Hist | undefined;
  let natUrl: URL;
  try {
    natUrl = new NativeURL(nat.href);
  } catch {
    return;
  }
  /* The entry route, captured at bootstrap: every re-anchor rides
     it, so history entries stay siblings under one route. An
     engine-origin root document anchors nothing. A prel tail is
     stripped first: a document loaded at a re-anchored
     <entry>/__zl_prel__/<encoded> URL must anchor NEW tails on
     the bare entry. Anchoring on the accumulated pathname nests
     the previous tail inside every re-encoded tail, and each
     fallback reload doubled it (the Brave Ask snowball: 429
     loops, then a 414 Request-URI-Too-Long). */
  /* Injector phase 2: a query-shape committed URL carries the route
     token in the search; re-anchors keep the token and commit the
     real path natively. */
  /* #532: engine-rewritten nested documents with an about: URL
     (iframe srcdoc; about:blank frames never have engine-rewritten
     bytes). The rewriter renames document.URL/documentURI/baseURI
     reads inside the nested document too (the srcdoc value IS
     rewritten as a sub-document), but no entry route exists, so
     the old bail left __zl undefined and every renamed read threw
     a ReferenceError. The faithful virtual view of an about:
     document IS its native value: a direct srcdoc document reads
     about:srcdoc for href, document.URL and baseURI alike. */
  if (natUrl.protocol === "about:") {
    const zlAbout = {
      get href(): string {
        return nat.href;
      },
      get baseURI(): string {
        return nat.href;
      },
      get pathname(): string {
        return natUrl.pathname;
      },
      set pathname(v: string) {
        try {
          (nat as unknown as { pathname?: string }).pathname = v;
        } catch {
          /* a sealed location keeps the native value */
        }
      },
      get search(): string {
        return natUrl.search;
      },
      get hash(): string {
        return nat.hash;
      },
      set hash(v: string) {
        try {
          (nat as { hash: string }).hash = v;
        } catch {
          /* a sealed location keeps the native hash */
        }
      },
      origin: natUrl.origin,
      protocol: natUrl.protocol,
      host: natUrl.host,
      hostname: natUrl.hostname,
      port: natUrl.port,
      assign(u: string): void {
        nat.assign(String(u));
      },
      replace(u: string): void {
        nat.replace(String(u));
      },
      reload(): void {
        nat.reload();
      },
      toString(): string {
        return nat.href;
      },
    };
    try {
      Object.defineProperty(w, "__zl", { value: zlAbout, configurable: true });
    } catch {
      /* a sealed realm keeps the native location view */
    }
    return;
  }
  const navq = navqStrip(natUrl.search);
  const navpCut = natUrl.pathname.indexOf(NAVP);
  const entry =
    navpCut > 0 ? natUrl.pathname.slice(0, navpCut) : natUrl.pathname;
  if (entry.length < 2 && navq === null) return;
  const origin = natUrl.origin;

  /* Virtual path from the native URL: a NAVH handle carries the
     real path visibly after the token (#144), a NAVP re-anchor
     carries it encoded; anything else is not a page route. */
  const fromNative = (u: URL): string | null => {
    const pn = u.pathname;
    /* Injector phase 2: a query-shape route commits the real path and
       query natively; the token is the only engine mark in the URL.
       #411: the arm is presence-only (the page realm cannot
       MAC-verify), so it never wins on a route-shaped pathname: a
       NAVH-path page whose REAL destination query carries the
       engine-chosen param name misclassified every read and surfaced
       the opaque handle path as the virtual path. The worker side
       stays fail-closed (decodeClientUrl MAC-verifies the token). */
    const qs = navqStrip(u.search);
    if (qs !== null && !pn.startsWith(NAVH + "/") && pn.indexOf(NAVP + "/") < 0) {
      /* #410: builder-escaped surplus leading slashes restore, the
         same #202 parity as the NAVH arm below. */
      return restoreLeading(pn) + qs[1] + u.hash;
    }
    if (pn.startsWith(NAVH + "/")) {
      const tail = pn.slice(NAVH.length + 1);
      const slash = tail.indexOf("/");
      const rest = slash < 0 ? "/" : tail.slice(slash);
      /* A prel tail on the handle route is the NEWER virtual
         state (a re-anchored pushState/assign), not site path:
         decode it; the visible path before it is the load-time
         view. Reading the tail as path snowballed every
         re-anchor (the Brave Ask 414 class). */
      const tcut = rest.indexOf(NAVP);
      if (tcut >= 0) {
        try {
          const seg = rest.slice(tcut + NAVP.length);
          let d = decodeURIComponent(
            (seg.startsWith("/") ? seg.slice(1) : seg).split("#")[0],
          );
          if (d.charAt(0) === "/") {
            /* legacy snowball defense: an embedded marker inside
               the decoded tail is older accumulation, not path */
            const emb = d.indexOf(NAVP);
            if (emb >= 0) d = d.slice(0, emb);
            return u.hash ? d + u.hash : d;
          }
        } catch {
          /* an undecodable tail falls to the visible path */
        }
      }
      /* #202 parity: builder-escaped surplus leading slashes
         restore to the real "//" pathname (the module-level
         restoreLeading, #410's shared lockstep copy). */
      return restoreLeading(rest) + u.search + u.hash;
    }
    const cut = pn.indexOf(NAVP + "/");
    if (cut > 0) {
      let d: string;
      try {
        d = decodeURIComponent(pn.slice(cut + NAVP.length + 1));
      } catch {
        return null;
      }
      if (d.charAt(0) !== "/") return null;
      /* legacy snowball defense: an embedded marker inside the
         decoded tail is older accumulation, not path */
      const emb = d.indexOf(NAVP);
      if (emb >= 0) d = d.slice(0, emb);
      /* a native hash (an anchor click on the re-anchored URL) is
         newer than the hash pushed inside the tail */
      return u.hash ? d.split("#")[0] + u.hash : d;
    }
    return null;
  };

  /* The injected vpath (hostless real path) wins: it carries the
     destination's own hash too. Otherwise parse the native URL
     (NAVH), else the opaque route stands - the pre-#235 view. */
  let cur =
    typeof vpath === "string" && vpath.startsWith("/")
      ? vpath
      : fromNative(natUrl) ?? natUrl.pathname + natUrl.search + natUrl.hash;
  /* #543: a committed engine route can carry the destination fragment
     raw (NAVH and query handles, marker and mapped Location/Refresh
     routes mint fragment-free payloads) and the worker never sees a
     fragment, so a fragment-free injected vpath is not the whole
     story: the native hash is the only fragment witness and joins
     the view. A vpath carrying its own hash keeps it (the payload
     shape; the native hash is absent for those). */
  if (typeof vpath === "string" && vpath.startsWith("/") && !vpath.includes("#") && natUrl.hash) {
    cur = cur.split("#")[0] + natUrl.hash;
  }

  /* A navigation-bound input -> virtual path, or null (cross-origin
     or opaque: the caller passes through natively). Absolute
     http(s) URLs on the engine origin re-anchor to their
     pathname+search, the same #157 class. */
  const toVirtual = (v: string): string | null => {
    const s = String(v);
    if (s === "") return null;
    if (s.charAt(0) === "#") return cur.split("#")[0] + s;
    let u: URL;
    try {
      u = new NativeURL(s, "http://v" + cur);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    /* an absolute input naming another origin is not this page's
       path: null, the caller passes through natively. #239: the
       scheme test runs on the whitespace-stripped text (the URL
       parser strips it too) and a protocol-relative tail is an
       absolute input, so no cross-origin resolution slips through
       as a same-origin path. */
    const lead = s.replace(/^[\u0000-\u0020]+/, "");
    if (
      (/^[a-z][a-z0-9+.-]*:/i.test(lead) || /^[\\/][\\/]/.test(lead)) &&
      u.origin !== origin
    ) {
      return null;
    }
    /* A route-shaped input is the page re-emitting its own opaque
       route (location is LegacyUnforgeable, so a native pathname
       or href read still carries the engine's markers), not a
       virtual path. Wrapping it in a prel tail stacked routes on
       top of routes - the prel-of-prel mint whose reload served
       the engine markers upstream (the google.com/ai 404 class).
       Decode it back to the virtual state it carries instead. */
    if (u.pathname.startsWith(NAVH + "/") || u.pathname.indexOf(NAVP + "/") > 0) {
      try {
        const dec = fromNative(new NativeURL("http://v" + u.pathname + u.search + u.hash));
        if (dec !== null) return dec;
      } catch {
        /* fall through to the plain-path read */
      }
    }
    return u.pathname + u.search + u.hash;
  };

  /* Virtual path -> re-anchored engine-local route. Injector phase 2:
     a query-shape page re-commits the REAL path natively and keeps
     the token (the token names the origin only, so any path under it
     decodes): history entries read the real pathname and a reload of
     any of them deep-links back to the same virtual path. */
  const anchor = (virt: string): string => {
    if (navq === null) return entry + NAVP + "/" + encodeURIComponent(virt);
    const hashCut = virt.indexOf("#");
    const base = hashCut >= 0 ? virt.slice(0, hashCut) : virt;
    const hash = hashCut >= 0 ? virt.slice(hashCut) : "";
    /* #410: a "//"-leading virtual path re-commits escaped, the
       mint's form - a raw "//" path would resolve protocol-relative
       on the committed URL. */
    const qCut = base.indexOf("?");
    const path = qCut >= 0 ? base.slice(0, qCut) : base;
    /* #558 residual: the page realm cannot hide the committed token
       (a native read leaks it, the #418 LegacyUnforgeable class), so
       a page re-emitting its own URL in pushState/replaceState or a
       location write carried live tokens back; the append below then
       stacked one identical token per re-anchor. Strip every carried
       token from the query and append the live one exactly once. */
    let query = qCut >= 0 ? base.slice(qCut) : "";
    for (let strip = navqStrip(query); strip !== null; strip = navqStrip(query)) {
      query = strip[1];
    }
    return escapeLeading(path) + query + (query ? "&" : "?") + NAVQ + "=" + navq[0] + hash;
  };

  /* #532: the virtual document base for __zl.baseURI reads. The
     served first <base href> is rewritten to an opaque engine
     route, so the page realm cannot decode it: the worker posts
     the folded base (hostless, the same #144 relaxation as
     vpath) as a zl:vbase control message once the rewriter folds
     it, and servedHrefRaw captures the raw attribute bytes of the
     first base seen after delivery so a LATER page-set href is
     recognized as page truth (the delivered value stops applying
     the moment the raw attribute differs). */
  let servedVbase: string | null = null;
  let servedHrefRaw: string | null = null;
  const firstBaseHref = (): string | null => {
    try {
      const doc = w.document as Document | undefined;
      if (!doc || typeof doc.querySelectorAll !== "function") return null;
      for (const el of doc.querySelectorAll("base")) {
        const h = el.getAttribute("href");
        if (h) return h;
      }
    } catch {
      /* no DOM access: the spec default below */
    }
    return null;
  };
  /* A page-set base value resolves through the same virtual
     semantics as navigation inputs: a cross-origin absolute is the
     page own choice (page-visible data, not engine-injected
     identity), NAVH/NAVP-shaped route values decode, a plain
     relative resolves against the current virtual path. */
  const resolveBase = (raw: string): string => {
    const s = String(raw);
    let u: URL;
    try {
      u = new NativeURL(s, "http://v" + cur);
    } catch {
      return cur;
    }
    const lead = s.replace(/^[\u0000-\u0020]+/, "");
    if (
      (/^[a-z][a-z0-9+.-]*:/i.test(lead) || /^[\\/][\\/]/.test(lead)) &&
      u.origin !== origin
    ) {
      return s;
    }
    if (u.pathname.startsWith(NAVH + "/") || u.pathname.indexOf(NAVP + "/") > 0) {
      try {
        const dec = fromNative(
          new NativeURL("http://v" + u.pathname + u.search + u.hash),
        );
        if (dec !== null) return dec;
      } catch {
        /* fall through to the plain-path read */
      }
    }
    return u.pathname + u.search + u.hash;
  };
  const vbaseOf = (): string => {
    try {
      const raw = firstBaseHref();
      if (raw === null) return origin + cur;
      if (servedVbase !== null) {
        if (servedHrefRaw === null) servedHrefRaw = raw;
        if (raw === servedHrefRaw) return origin + servedVbase;
      }
      const resolved = resolveBase(raw);
      /* a page-chosen cross-origin base is already a full URL: the
         page wrote it, it is page-visible data, and the native
         frozen base would be that exact URL too. */
      if (/^[a-z][a-z0-9+.-]*:/i.test(resolved)) return resolved;
      return origin + resolved;
    } catch {
      return origin + cur;
    }
  };
  {
    const ns = (w.navigator as
      | { serviceWorker?: { addEventListener?: (t: string, f: (ev: MessageEvent) => void) => void } }
      | undefined)?.serviceWorker;
    if (ns && typeof ns.addEventListener === "function") {
      ns.addEventListener("message", (ev: MessageEvent) => {
        const d = ev.data as { type?: unknown; vbase?: unknown } | null;
        if (!d || d.type !== "zl:vbase") return;
        const vb = d.vbase;
        if (typeof vb === "string" && vb.startsWith("/")) servedVbase = vb;
        if (servedHrefRaw === null && firstBaseHref() !== null) {
          servedHrefRaw = firstBaseHref();
        }
      });
    }
  }

  const go = (v: string, replace: boolean): void => {
    const s = String(v);
    if (s === "") return;
    if (s.charAt(0) === "#") {
      /* hash-only: keep it on the native URL so hashchange and
         the browser's own surfaces stay honest */
      try {
        if (replace) nat.replace(s);
        else (nat as { hash: string }).hash = s;
      } catch {
        /* a sealed location keeps the native hash */
      }
      return;
    }
    const virt = toVirtual(s);
    if (virt === null) {
      /* cross-origin or opaque: native, the navguard navigate
         seam owns the class */
      if (replace) nat.replace(s);
      else nat.assign(s);
      return;
    }
    const t = anchor(virt);
    if (replace) nat.replace(t);
    else nat.assign(t);
  };

  if (hist) {
    for (const m of ["pushState", "replaceState"] as const) {
      const O = hist[m];
      if (typeof O !== "function") continue;
      hist[m] = function (st: unknown, t: string, u?: string | null) {
        if (u == null || u === "") return O.call(hist, st, t, u);
        const virt = toVirtual(String(u));
        if (virt === null) return O.call(hist, st, t, u);
        cur = virt;
        moved(virt);
        return O.call(hist, st, t, anchor(virt));
      };
    }
  }

  /* Registered before any page listener can be (the bootstrap
     runs first), so page popstate handlers read the updated view. */
  const sync = (): void => {
    let u: URL;
    try {
      u = new NativeURL(nat.href);
    } catch {
      return;
    }
    const p = fromNative(u);
    if (p !== null) {
      cur = p;
      moved(p);
      return;
    }
    /* a non-routed native URL (an opaque route): only the hash
       moves on it */
    cur = cur.split("#")[0] + u.hash;
  };
  const AE = w.addEventListener as
    | ((t: string, fn: () => void) => void)
    | undefined;
  if (typeof AE === "function") {
    AE.call(w, "popstate", sync);
    AE.call(w, "hashchange", sync);
  }

  /* The location-like view the #235 renames read. */
  const zl = {
    get href(): string {
      return origin + cur;
    },
    /* #532: document.baseURI renames read this view. Spec default
       (no base element) is the virtual document URL; the served
       base serves through the delivered hostless value; a page-set
       base is page truth (live DOM read, dynamic <base> changes
       reflect immediately). */
    get baseURI(): string {
      return vbaseOf();
    },
    set href(v: string) {
      go(v, false);
    },
    get pathname(): string {
      return new NativeURL("http://v" + cur).pathname;
    },
    /* #182: a pathname write navigates (the native semantic),
       keeping the current search and hash. */
    set pathname(v: string) {
      let u: URL;
      try {
        u = new NativeURL(String(v), "http://v" + cur);
      } catch {
        return;
      }
      const c = new NativeURL("http://v" + cur);
      go(u.pathname + c.search + c.hash, false);
    },
    get search(): string {
      return new NativeURL("http://v" + cur).search;
    },
    /* #182: a search write replaces the query, keeps the path
       and hash, and navigates. */
    set search(v: string) {
      const c = new NativeURL("http://v" + cur);
      const q = v === "" ? "" : v.startsWith("?") ? v : "?" + v;
      go(c.pathname + q + c.hash, false);
    },
    get hash(): string {
      return new NativeURL("http://v" + cur).hash;
    },
    /* #182: a hash write mirrors natively so the history entry
       and hashchange stay real, and the view moves up front so
       a read-after-write sees it like the native location. */
    set hash(v: string) {
      const h = v.startsWith("#") ? v : "#" + v;
      cur = cur.split("#")[0] + h;
      moved(cur);
      try {
        (nat as { hash: string }).hash = h;
      } catch {
        /* a sealed location keeps the native hash */
      }
    },
    /* origin/protocol/host stay native: the #157 own-origin
       re-anchor class depends on them. */
    origin,
    protocol: natUrl.protocol,
    host: natUrl.host,
    hostname: natUrl.hostname,
    port: natUrl.port,
    assign(u: string): void {
      go(u, false);
    },
    replace(u: string): void {
      go(u, true);
    },
    reload(): void {
      nat.reload();
    },
    toString(): string {
      return origin + cur;
    },
  };
  try {
    Object.defineProperty(w, "__zl", { value: zl, configurable: true });
  } catch {
    /* a sealed realm keeps the native location view */
  }
}
