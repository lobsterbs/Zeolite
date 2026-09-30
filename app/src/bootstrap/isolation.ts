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
     navigations keep it, another virtual site starts from empty.
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
      const handlers = new Set<StorageHandler>();
      let onstorage: StorageHandler | null = null;
      const wrappedAdd = (t: string, l: unknown, o?: unknown): void => {
        if (t === "storage" && typeof l === "function") {
          handlers.add(l as StorageHandler);
          return;
        }
        add(t, l, o);
      };
      const wrappedRem = (t: string, l: unknown, o?: unknown): void => {
        if (t === "storage") {
          handlers.delete(l as StorageHandler);
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
          for (const h of [...handlers]) {
            try {
              h(fake);
            } catch {
              /* ditto */
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
        nm = SS.getItem(KEY) ?? "";
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
      function ScopedChannel(this: unknown, name: string): RealChannel & {
        name: string;
      } {
        const real = new BCtor(P + name);
        return {
          name,
          get onmessage() {
            return real.onmessage;
          },
          set onmessage(fn) {
            real.onmessage = fn;
          },
          get onmessageerror() {
            return real.onmessageerror;
          },
          set onmessageerror(fn) {
            real.onmessageerror = fn;
          },
          postMessage: (m: unknown) => real.postMessage(m),
          close: () => real.close(),
          addEventListener: (t: string, l: unknown, o?: unknown) =>
            real.addEventListener(t, l, o),
          removeEventListener: (t: string, l: unknown, o?: unknown) =>
            real.removeEventListener(t, l, o),
          dispatchEvent: (ev: Event) => real.dispatchEvent(ev),
        };
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
