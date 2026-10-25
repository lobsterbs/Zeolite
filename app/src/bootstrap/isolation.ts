/* Virtual browser API isolation beyond storage/cookies (issue #37).

   The engine serves every virtual site from one real origin, so any
   engine-origin-wide browser channel or context-lifetime value leaks
   across virtual sites unless it is explicitly scoped:

   - storage events: a raw "storage" event carries the prefixed key of
     whichever virtual site wrote it. Only this site's keys are
     delivered, prefix stripped, storageArea pointing at the page's own
     scoped Storage; another site's writes and engine-own keys are
     dropped before a page listener ever sees them.
   - BroadcastChannel: channel names are origin-wide; every channel is
     moved onto a site-prefixed real name (the page-visible .name keeps
     the page's spelling), so two virtual sites never hear each other.
   - window.name: one browsing context is reused across virtual sites
     and the raw value survives the switch. It is scoped through the
     (already site-scoped) sessionStorage: reloads and same-site
     navigations keep it, another virtual site starts from empty. A
     fresh context seeds its real browsing-context name from the frame
     element (#132 follow-up: gstatic's recaptcha bframe resolves its
     anchor by name, parent.frames["a-<id>"], so an empty name broke
     the widget's cross-frame channel); top-level windows have no
     frame element and still start from empty.
   - cookieStore: it reads the real engine-origin cookie jar, not the
     virtual per-site jar. It cannot be implemented correctly on top of
     the jar (async semantics, change events) without faking, so it is
     removed and feature detection sees an absent API that falls back
     to the virtual document.cookie - honest absence, never a fake
     (issue #37 constraint: do not fake APIs).

   Every install is defineProperty-based: on a read-only context the
   API stays native and the gap is documented (docs/matrix.md). Plain
   assignment against accessor-only Window properties silently
   no-ops in the classic sloppy-mode bundle - the #35 lesson. */

import type { ScopedStorages } from "./storage";

/* The real channel the wrapper forwards to. */
interface RealChannel {
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onmessageerror: ((ev: MessageEvent) => unknown) | null;
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: string, listener: unknown, options?: unknown): void;
  removeEventListener(type: string, listener: unknown, options?: unknown): void;
  dispatchEvent(event: Event): boolean;
}

type StorageHandler = (ev: StorageEvent) => unknown;

export function applyIsolation(
  w: Record<string, unknown>,
  P: string,
  st: ScopedStorages,
): void {
  /* ---- storage events ---------------------------------------------- */
  /* Only installed when the scoped storages both installed: the filter
     assumes page writes carry the prefix, which is only true then. */
  if (st.installed) {
    const add = w.addEventListener as
      | ((t: string, l: unknown, o?: unknown) => void)
      | undefined;
    const rem = w.removeEventListener as
      | ((t: string, l: unknown, o?: unknown) => void)
      | undefined;
    if (typeof add === "function" && typeof rem === "function") {
      /* #266: keyed by the RAW listener so removeEventListener finds
         the same registration for functions and object listeners.
         #475: registration identity is (listener, capture); once and
         AbortSignal are honored by the synthetic delivery. */
      type Reg = { h: StorageHandler; once: boolean };
      const handlers = new Map<unknown, Map<boolean, Reg>>();
      const capOf = (o?: unknown): boolean =>
        !!o && (typeof o === "object" ? !!(o as { capture?: unknown }).capture : true);
      const onceOf = (o?: unknown): boolean =>
        !!o && typeof o === "object" && !!(o as { once?: unknown }).once;
      const drop = (l: unknown, cap: boolean): void => {
        const m = handlers.get(l);
        if (m) {
          m.delete(cap);
          if (!m.size) handlers.delete(l);
        }
      };
      let onstorage: StorageHandler | null = null;
      const wrappedAdd = (t: string, l: unknown, o?: unknown): void => {
        /* #266: an object-style listener ({ handleEvent(ev) {} }) is as
           standard as a function listener; both are filtered here, and
           neither ever reaches the real (unfiltered) registration. */
        if (t === "storage") {
          const h: StorageHandler | null =
            typeof l === "function"
              ? (l as StorageHandler)
              : l !== null &&
                  typeof l === "object" &&
                  typeof (l as EventListenerObject).handleEvent === "function"
                ? (ev) => (l as EventListenerObject).handleEvent(ev)
                : null;
          if (h) {
            const cap = capOf(o);
            let byCap = handlers.get(l);
            if (!byCap) {
              byCap = new Map();
              handlers.set(l, byCap);
            }
            if (!byCap.has(cap)) byCap.set(cap, { h, once: onceOf(o) });
            const sig =
              !!o && typeof o === "object" ? (o as { signal?: AbortSignal }).signal : undefined;
            if (sig) {
              try {
                sig.addEventListener("abort", () => drop(l, cap));
              } catch {
                /* not a real AbortSignal: the manual remove still works */
              }
            }
            return;
          }
        }
        add(t, l, o);
      };
      const wrappedRem = (t: string, l: unknown, o?: unknown): void => {
        if (t === "storage") {
          drop(l, capOf(o));
          return;
        }
        rem(t, l, o);
      };
      /* Register the page's listeners only if BOTH interception points
         install: a half-installed filter would double-deliver. */
      let interceptOk = true;
      try {
        Object.defineProperty(w, "addEventListener", {
          value: wrappedAdd,
          configurable: true,
        });
      } catch {
        interceptOk = false;
      }
      try {
        Object.defineProperty(w, "removeEventListener", {
          value: wrappedRem,
          configurable: true,
        });
      } catch {
        interceptOk = false;
      }
      try {
        Object.defineProperty(w, "onstorage", {
          get: () => onstorage,
          set: (fn: unknown) => {
            onstorage =
              typeof fn === "function" ? (fn as StorageHandler) : null;
          },
          configurable: true,
        });
      } catch {
        /* onstorage stays native: the addEventListener filter still
           covers the standard registration path. */
      }
      if (interceptOk) {
        /* The one REAL listener: everything the page registered is
           called with the filtered, prefix-stripped event instead. */
        add("storage", (ev: Event) => {          const e = ev as StorageEvent;
          if (
            typeof e.key !== "string" ||
            !e.key.startsWith(P)
          ) {
            return; // another virtual site's write, or an engine-own key: dropped
          }
          const area =
            e.storageArea === st.realLocal
              ? st.scopedLocal
              : e.storageArea === st.realSession
                ? st.scopedSession
                : st.scopedLocal;
          const init: StorageEventInit = {
            key: e.key.slice(P.length),
            newValue: e.newValue,
            oldValue: e.oldValue,
            storageArea: area,
          };
          try {
            init.url = (w.location as Location | undefined)?.href ?? "";
          } catch {
            init.url = "";
          }
          let fake: StorageEvent;
          try {
            fake = new StorageEvent("storage", init);
          } catch {
            /* No StorageEvent constructor on this host (never a real
               browser): a structural stand-in with the same readable
               fields keeps the shim honest and testable. */
            fake = { type: "storage", ...init } as unknown as StorageEvent;
          }
          if (onstorage) {
            try {
              onstorage(fake);
            } catch {
              /* a page handler threw: not ours to surface */
            }
          }
          for (const [l, byCap] of [...handlers.entries()]) {
            for (const [cap, reg] of [...byCap.entries()]) {
              try {
                reg.h(fake);
              } catch {
                /* ditto */
              }
              if (reg.once) drop(l, cap);
            }
          }
        });
      } else {
        /* Half-installed interception is a silent black hole: page
           handlers would be captured by the wrapper and never
           dispatched. Restore both originals so the native path
           (prefixed keys, documented) keeps working. */
        try {
          Object.defineProperty(w, "addEventListener", {
            value: add,
            configurable: true,
          });
        } catch {
          /* nothing more to try */
        }
        try {
          Object.defineProperty(w, "removeEventListener", {
            value: rem,
            configurable: true,
          });
        } catch {
          /* nothing more to try */
        }
      }
    }
  }

  /* ---- window.name --------------------------------------------------- */
  {
    const SS = st.scopedSession;
    if (SS) {
      const KEY = "__zl-name";
      let nm = "";
      try {
        const cur = SS.getItem(KEY);
        nm = cur ?? "";
        if (cur === null) {
          /* #132 follow-up: fresh scoped context - keep the browsing
             context's real name (recaptcha's bframe resolves its
             anchor through it: parent.frames["a-<id>"]). Top-level
             windows (no frame element) still start empty. */
          try {
            const fe = (w as { frameElement?: Element | null }).frameElement;
            const attr = fe?.getAttribute("name") ?? "";
            if (attr) nm = attr;
          } catch {
            /* frameElement unreadable (cross-origin): empty start */
          }
        }
      } catch {
        /* storage threw: name starts empty */
      }
      try {
        Object.defineProperty(w, "name", {
          get: () => nm,
          set: (v: unknown) => {
            nm = typeof v === "string" ? v : String(v ?? "");
            try {
              SS.setItem(KEY, nm);
            } catch {
              /* quota: the in-memory value still holds */
            }
          },
          configurable: true,
        });
      } catch {
        /* read-only: window.name stays native (documented) */
      }
    }
  }

  /* ---- BroadcastChannel ----------------------------------------------- */
  {
    const BC = w.BroadcastChannel as
      | (new (name: string) => RealChannel)
      | undefined;
    if (typeof BC === "function") {
      /* Narrowing does not survive into the hoisted ScopedChannel body;
         pin the non-optional type once. */
      const BCtor: new (name: string) => RealChannel = BC;
      /* #269: subclass the real ctor - instances keep the native
         EventTarget/BroadcastChannel surface (instanceof, new-only
         construction, listener this) while the constructor maps the
         visible name onto the site-prefixed internal channel. */
      class ScopedChannel extends BCtor {
        private readonly visible: string;
        constructor(name: string) {
          super(P + name);
          this.visible = name;
          /* ponytail: own getter because a base ctor may plant an own
             name (the test realm's fake does); native's is a
             prototype accessor, the shadowing is unobservable. */
          Object.defineProperty(this, "name", {
            configurable: true,
            get: () => this.visible,
          });
        }
      }
      try {
        Object.defineProperty(w, "BroadcastChannel", {
          value: ScopedChannel,
          configurable: true,
        });
      } catch {
        /* read-only: channels stay native (documented) */
      }
    }
  }

  /* ---- cookieStore ----------------------------------------------------- */
  try {
    /* Delete when configurable, so "cookieStore" in window is false. */
    delete (w as unknown as Record<string, unknown>).cookieStore;
  } catch {
    /* not configurable: the undefined shim below applies */
  }
  try {
    if (w.cookieStore !== undefined) {
      Object.defineProperty(w, "cookieStore", {
        value: undefined,
        configurable: true,
      });
    }
  } catch {
    /* read-only: stays native (documented) */
  }
}
