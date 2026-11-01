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
        return { locale: lc, messages: messagesFromJson(JSON.parse(new TextDecoder().decode(bytes))) };
      } catch {
        /* malformed messages.json: keep looking; Chrome falls back too */
      }
    }
  }
  return { locale: defaultLocale || "en", messages: {} };
}

export function i18nGetMessage(res: I18nResolved, name: unknown, substitutions?: unknown): string {
  if (typeof name !== "string") return "";
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
