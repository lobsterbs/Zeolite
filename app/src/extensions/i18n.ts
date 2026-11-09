/* Zeolite extension subsystem: chrome.i18n (#560 residual).

   getMessage answers from the package's own _locales exactly like
   Chrome resolves at runtime: candidate locales are the worker
   navigator's language, its primary subtag, then the manifest
   default_locale; the first messages.json that exists wins. Lookups
   are case-insensitive (Chrome folds message names); a missing name
   answers "". $NAME$ placeholders from the entry expand first (their
   content may itself carry $n), then $1..$9 map onto the
   substitutions. getUILanguage/getAcceptLanguages report the resolved
   locale - the engine has no locale host beyond the worker's
   navigator, which compat.ts states plainly. detectLanguage is
   absent: no language detector ships in a service-worker engine. */

export interface I18nEntry {
  message: string;
  placeholders: Record<string, string>;
}

export interface I18nResolved {
  locale: string;
  messages: Record<string, I18nEntry>;
  /* #523: the record id rides the resolution so the predefined
     @@extension_id can answer; absent when the caller has none. */
  id?: string;
}

/* Chrome folds message names case-insensitively; message keys here
   lowercase on parse so getMessage("Hello") == getMessage("HELLO").
   Placeholder names lowercase the same way. */
export function messagesFromJson(raw: unknown): Record<string, I18nEntry> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, I18nEntry> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (typeof v === "string") {
      out[name] = { message: v, placeholders: {} };
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    const msg = (v as Record<string, unknown>).message;
    if (typeof msg !== "string") continue;
    const ph: Record<string, string> = {};
    const rawPh = (v as Record<string, unknown>).placeholders;
    if (typeof rawPh === "object" && rawPh !== null) {
      for (const [pk, pv] of Object.entries(rawPh as Record<string, unknown>)) {
        if (
          typeof pv === "object" &&
          pv !== null &&
          typeof (pv as Record<string, unknown>).content === "string"
        ) {
          ph[pk.toLowerCase()] = (pv as Record<string, unknown>).content as string;
        }
      }
    }
    out[name] = { message: msg, placeholders: ph };
  }
  return out;
}

export async function resolvePackageI18n(
  defaultLocale: string,
  read: (path: string) => Promise<Uint8Array | null>,
  id?: string,
): Promise<I18nResolved> {
  const nav =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language
      : "";
  const candidates: string[] = [];
  if (nav) {
    candidates.push(nav);
    const primary = nav.split("-")[0];
    if (primary && primary !== nav) candidates.push(primary);
  }
  if (defaultLocale) candidates.push(defaultLocale);
  for (const lc of candidates) {
    for (const p of ["_locales/" + lc + "/messages.json", "/_locales/" + lc + "/messages.json"]) {
      const bytes = await read(p);
      if (!bytes) continue;
      try {
        return { locale: lc, messages: messagesFromJson(JSON.parse(new TextDecoder().decode(bytes))), ...(id ? { id } : {}) };
      } catch {
        /* malformed messages.json: keep looking; Chrome falls back too */
      }
    }
  }
  return { locale: defaultLocale || "en", messages: {}, ...(id ? { id } : {}) };
}

export function i18nGetMessage(res: I18nResolved, name: unknown, substitutions?: unknown): string {
  if (typeof name !== "string") return "";
  /* #523: the predefined @@ messages resolve like Firefox's
     locale-specific message reference documents. */
  const pre = predefinedMessage(res, name);
  if (pre !== null) return pre;
  const entry = res.messages[name.toLowerCase()];
  if (!entry) return "";
  const subs: string[] = Array.isArray(substitutions)
    ? substitutions.map(String)
    : substitutions === undefined || substitutions === null
      ? []
      : [String(substitutions)];
  /* Placeholders first: their content may itself carry $n. */
  let out = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (full, key: string) => {
    const ph = entry.placeholders[key.toLowerCase()];
    return ph !== undefined ? ph : full;
  });
  out = out.replace(/\$([1-9])/g, (full, d: string) => {
    const i = Number(d) - 1;
    return i < subs.length ? subs[i] : full;
  });
  return out;
}

export function makeI18nNs(res: I18nResolved): {
  getMessage(name: unknown, substitutions?: unknown): string;
  getUILanguage(): string;
  getAcceptLanguages(): Promise<string[]>;
} {
  return {
    getMessage: (name, substitutions) => i18nGetMessage(res, name, substitutions),
    getUILanguage: () => res.locale,
    getAcceptLanguages: () =>
      Promise.resolve(
        typeof navigator !== "undefined" &&
          Array.isArray(navigator.languages) &&
          navigator.languages.length
          ? [...navigator.languages]
          : [res.locale],
      ),
  };
}

/* #523: Firefox's predefined messages (the MDN locale-specific
   message reference), resolvable in getMessage and in CSS
   substitution: @@extension_id, @@ui_locale and the @@bidi_*
   family. Direction derives from the resolved locale's primary
   subtag against the common RTL set - an approximation of
   Firefox's full CLDR table, stated plainly in compat. */
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "yi", "ckb", "sd", "ug"]);
export function predefinedMessage(res: I18nResolved, name: string): string | null {
  if (name === "@@extension_id") return res.id ?? "";
  if (name === "@@ui_locale") return res.locale;
  const rtl = RTL.has(res.locale.split("-")[0].toLowerCase());
  if (name === "@@bidi_dir") return rtl ? "rtl" : "ltr";
  if (name === "@@bidi_reversed_dir") return rtl ? "ltr" : "rtl";
  if (name === "@@bidi_start_edge") return rtl ? "right" : "left";
  if (name === "@@bidi_end_edge") return rtl ? "left" : "right";
  return null;
}

const keyChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "@";

/** #523: Firefox locale-dependent CSS (MDN Internationalization):
    __MSG_<name>__ tokens in package .css files resolve against the
    package's _locales with the same lookup getMessage uses,
    predefined @@ messages included, so the documented @@bidi_*
    CSS example works. A token that cannot resolve keeps its
    literal bytes - the documented lenience the manifest path
    (#504) already applies. Scanned, not regexed. */
export function substituteCss(css: string, res: I18nResolved): string {
  if (!css.includes("__MSG_")) return css;
  let out = "";
  let i = 0;
  for (;;) {
    const at = css.indexOf("__MSG_", i);
    if (at < 0) return out + css.slice(i);
    let end = at + 6;
    while (end < css.length && keyChar(css[end]) && css.slice(end, end + 2) !== "__") end++;
    if (css.slice(end, end + 2) !== "__") {
      /* no terminator: keep the literal bytes and move on */
      out += css.slice(i, end);
      i = end;
      continue;
    }
    const key = css.slice(at + 6, end);
    const hit = key.startsWith("@@") || res.messages[key.toLowerCase()] !== undefined;
    out += css.slice(i, at) + (hit ? i18nGetMessage(res, key) : css.slice(at, end + 2));
    i = end + 2;
  }
}

/* #523: CSS substitution resolves the record's locales once per
   install (the record object is per-install: a reload re-parses
   into a fresh record, an uninstall drops the memo with it). */
const i18nMemo = new WeakMap<object, Promise<I18nResolved>>();
export function recordI18n(
  rec: { id?: unknown; manifest?: { default_locale?: unknown } },
  read: (path: string) => Promise<Uint8Array | null>,
): Promise<I18nResolved> {
  let p = i18nMemo.get(rec);
  if (!p) {
    const dl = rec.manifest?.default_locale;
    p = resolvePackageI18n(
      typeof dl === "string" ? dl : "",
      read,
      typeof rec.id === "string" ? rec.id : undefined,
    );
    i18nMemo.set(rec, p);
  }
  return p;
}
