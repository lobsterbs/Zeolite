/* Runtime navigation guard + WebRTC gate (issues #28, #39).

   The service worker only intercepts navigations inside its own
   scope: a cross-origin navigation (window.open, an anchor href, a
   form action) goes straight from the page to the real origin,
   exposing the client IP and hostname. The rewriter covers URLs in
   server-provided markup; this module covers the runtime DOM seams.
   Rewritten absolute URLs become engine-local NAV marker routes,
   which the SW decodes and proxies like any engine route
   (cross-origin navigations would otherwise never reach the fetch
   handler at all). Issue #32: the marker encodes the target
   base64url, so no plaintext destination reaches the DOM value, the
   address bar or history.

   Honest limits, by design:
   - location is LegacyUnforgeable: location.href = "..." cannot be
     hooked directly. #39 closes the escape class through the
     Navigation API instead: the navigate event fires in this
     document for every cross-document navigation it initiates and
     is cancelable for push/replace/reload types, so the guard
     cancels a real-origin navigation and re-drives it through the
     marker. Browsers without window.navigation keep the old limit.
     Traverse (back/forward) navigations cannot be canceled, but
     history only ever holds engine routes (#32), so no real-origin
     destination can sit in it.
   - URLs inserted through the HTML parser (innerHTML, document.write)
     bypass the property and setAttribute hooks, but the navigations
     they eventually trigger still fire the navigate event, so
     parser-inserted anchors, forms and meta refresh are covered by
     the same seam. Parser-inserted iframe src assignments remain
     outside it (the child frame has no bootstrap yet).
   - Engine-origin, relative and opaque URLs pass through untouched:
     those requests stay inside the SW scope and it reroutes them
     natively. <base href> is deliberately left alone (rewriting it
     would break relative resolution for the whole page).
   - RTCPeerConnection is removed, not shimmed: WebRTC connects
     directly, cannot be routed through the engine, and leaving a
     constructible-looking API would be a fake feature. */

export const NAV = "/__zl_nav__";

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
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
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
): void {
  /* Absolute http(s) URLs off the engine origin become marker routes;
     everything else (relative, opaque scheme, engine-local, already
     routed) passes through unchanged. */
  const rewire = (v: string): string => {
    let u: URL;
    try {
      u = new URL(String(v), loc);
    } catch {
      return String(v);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return String(v);
    if (u.origin === engineOrigin) return String(v);
    return navEncode(u.href);
  };
  /* Reads must return what the page wrote: frameworks compare href
     values, so the raw string is kept per element and the marker only
     reaches the browser. */
  const raw = new WeakMap<object, string>();
  const guardProp = (proto: AnyRecord, prop: string): void => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: true,
      get(this: AnyRecord) {
        return raw.get(this) ?? d.get!.call(this);
      },
      set(this: AnyRecord, v: string) {
        raw.set(this, String(v));
        d.set!.call(this, rewire(String(v)));
      },
    });
  };
  const guardAttr = (proto: AnyRecord, attr: string): void => {
    const O = proto.setAttribute;
    if (typeof O !== "function") return;
    proto.setAttribute = function (this: AnyRecord, n: string, v: string) {
      return O.call(this, n, n === attr ? rewire(String(v)) : v);
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
  const table: Array<[AnyRecord | undefined, string]> = [
    [w.HTMLAnchorElement as AnyRecord, "href"],
    [w.HTMLAreaElement as AnyRecord, "href"],
    [w.HTMLIFrameElement as AnyRecord, "src"],
    [w.HTMLFormElement as AnyRecord, "action"],
    [w.HTMLLinkElement as AnyRecord, "href"],
  ];
  for (const [C, prop] of table) {
    if (!C) continue;
    const proto = C.prototype;
    safe(() => guardProp(proto, prop));
    safe(() => guardAttr(proto, prop));
  }
  const OW = w.open;
  if (typeof OW === "function") {
    safe(() => {
      w.open = function (this: AnyRecord, u?: string | URL, t?: string, f?: string) {
        const s = u == null ? undefined : typeof u === "string" ? u : u.href;
        return (OW as AnyRecord).call(this, s == null ? u : rewire(s), t, f);
      };
    });
  }
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
          destination?: { url?: string; sameDocument?: boolean };
          formData?: FormData | null;
          preventDefault(): void;
        };
        if (!ev.cancelable || ev.destination?.sameDocument) return;
        const dest = String(ev.destination?.url ?? "");
        const marker = rewire(dest);
        if (marker === dest) return;
        ev.preventDefault();
        if (ev.formData) {
          const f = (w.document as Document).createElement("form") as HTMLFormElement;
          f.method = "POST";
          f.action = marker;
          f.style.display = "none";
          for (const [k, v] of (ev.formData as FormData).entries()) f.append(k, v);
          (w.document as Document).body.appendChild(f);
          f.submit();
          f.remove();
        } else {
          (w.location as { href: string }).href = marker;
        }
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
  /* WebRTC connects directly; presence would be a fake feature. */
  delete w.RTCPeerConnection;
}
