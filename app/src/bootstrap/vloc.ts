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

   Honest limits: bare top/parent reads stay native (#235 keeps
   frame-buster identity), so top.location still exposes the
   opaque route to comparisons; writes to location itself stay
   native for the same reason. Without an entry route (an
   engine-origin root document) nothing installs. */

import { NAVP } from "./navguard";

/* Local copy of the handle marker: the bootstrap bundle stays
   independent of codec.ts (size gate), same as navguard's NAV. */
const NAVH = "/__zl_navh__";

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
    natUrl = new URL(nat.href);
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
  const navpCut = natUrl.pathname.indexOf(NAVP);
  const entry =
    navpCut > 0 ? natUrl.pathname.slice(0, navpCut) : natUrl.pathname;
  if (entry.length < 2) return;
  const origin = natUrl.origin;

  /* Virtual path from the native URL: a NAVH handle carries the
     real path visibly after the token (#144), a NAVP re-anchor
     carries it encoded; anything else is not a page route. */
  const fromNative = (u: URL): string | null => {
    const pn = u.pathname;
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
         restore to the real "//" pathname. */
      const path = rest.replace(
        /^\/((?:%2F)+)/,
        (_all: string, run: string) => "/" + "/".repeat(run.length / 3),
      );
      return path + u.search + u.hash;
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
      u = new URL(s, "http://v" + cur);
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
        const dec = fromNative(new URL("http://v" + u.pathname + u.search + u.hash));
        if (dec !== null) return dec;
      } catch {
        /* fall through to the plain-path read */
      }
    }
    return u.pathname + u.search + u.hash;
  };

  /* Virtual path -> re-anchored engine-local route. */
  const anchor = (virt: string): string =>
    entry + NAVP + "/" + encodeURIComponent(virt);

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
      u = new URL(nat.href);
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
    set href(v: string) {
      go(v, false);
    },
    get pathname(): string {
      return new URL("http://v" + cur).pathname;
    },
    get search(): string {
      return new URL("http://v" + cur).search;
    },
    get hash(): string {
      return new URL("http://v" + cur).hash;
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
