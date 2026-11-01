/* Zeolite extension subsystem: manifest.json parsing.

   Targets Firefox-style WebExtensions, MV2 and MV3. Firefox MV3 is NOT
   Chrome MV3: notably Firefox runs background scripts (persistent
   background pages) where Chrome uses a service worker, and treats
   web_accessible_resources differently. The parser encodes those
   differences explicitly instead of assuming parity.

   Unknown fields never fail an install: the raw manifest is preserved
   and unknown field names are reported through diagnostics. Required
   fields (manifest_version, name, version) produce hard errors. */

import type {
  ActionSpec,
  BackgroundSpec,
  ContentScriptSpec,
  ExtensionRecord,
  ExternallyConnectableSpec,
  OptionsSpec,
  SidebarActionSpec,
} from "./types";

export interface ManifestDiagnostics {
  errors: string[];
  warnings: string[];
  unsupportedFields: string[];
}

export type ParsedExtension = Omit<
  ExtensionRecord,
  "id" | "state" | "enabled" | "installTime" | "lastError"
>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function objArr(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj);
}

function iconMap(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/* Looks like a Firefox host pattern rather than a named permission:
   "<all_urls>", or anything containing "://", or a bare "*." host. */
export function looksLikeHostPattern(p: string): boolean {
  return p === "<all_urls>" || p.includes("://") || p.startsWith("*.");
}

const KNOWN_FIELDS = new Set([
  "manifest_version", "name", "version", "description", "icons",
  "permissions", "host_permissions", "optional_permissions",
  "content_scripts", "background", "browser_action", "page_action",
  "action", "options_ui", "options_page", "web_accessible_resources",
  "commands", "content_security_policy", "browser_specific_settings",
  "externally_connectable", "sidebar_action", "author", "homepage_url",
  "default_locale", "locale", "applications", "minimum_chrome_version",
  "browser_style", "short_name", "update_url", "devtools_page",
  "chrome_settings_overrides", "chrome_url_overrides", "omnibox",
  "file_browser_handlers", "protocol_handlers", "web_request",
  "incognito", "offline_enabled", "optional_host_permissions",
  "granted_host_permissions", "hidden", "user_scripts", "export",
  "default_icon",
  /* #524: Firefox keys parsed below. theme/dictionaries are recorded
     on the record (no theme or spellcheck host yet — compat.ts says
     so); developer is plain metadata; lwt_* ride static themes. */
  "theme", "dictionaries", "developer", "lwt_background", "lwt_alpha",
]);

/** #524: Firefox accepts a GUID ({8-4-4-4-12} hex) or an id that looks
    like add-on@example.org. Anything else is a hard install error, as
    in Firefox ("The extension ID is invalid"). */
function validGeckoId(id: string): boolean {
  if (/^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(id)) return true;
  return /^[a-zA-Z0-9-._]+@[a-zA-Z0-9-._]+$/.test(id);
}

/** #524: dotted version bounds ("109.0", "128.0.1"); Firefox rejects
    non-numeric components. A malformed value warns and is recorded
    as-is — the engine does not enforce Gecko version ranges. */
function dottedVersion(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return /^\d+(\.\d+)*$/.test(v) ? v : null;
}

function parseContentScripts(v: unknown, diags: ManifestDiagnostics): ContentScriptSpec[] {
  const out: ContentScriptSpec[] = [];
  for (const cs of objArr(v)) {
    const matches = strArr(cs.matches);
    if (matches.length === 0) {
      diags.warnings.push("content_scripts: entry without matches ignored");
      continue;
    }
    const runRaw = typeof cs.run_at === "string" ? cs.run_at : "document_idle";
    const runAt: ContentScriptSpec["run_at"] =
      runRaw === "document_start" || runRaw === "document_end" || runRaw === "document_idle"
        ? runRaw
        : "document_idle";
    out.push({
      matches,
      exclude_matches: strArr(cs.exclude_matches),
      include_globs: strArr(cs.include_globs),
      exclude_globs: strArr(cs.exclude_globs),
      js: strArr(cs.js),
      css: strArr(cs.css),
      run_at: runAt,
      all_frames: cs.all_frames === true,
      match_about_blank: cs.match_about_blank === true,
    });
  }
  return out;
}

function parseBackground(
  v: unknown,
  mv: 2 | 3,
  diags: ManifestDiagnostics
): BackgroundSpec | null {
  if (!isObj(v)) return null;
  const scripts = strArr(v.scripts);
  const page = typeof v.page === "string" ? v.page : null;
  const sw = typeof v.service_worker === "string" ? v.service_worker : null;
  const persistent = v.persistent !== false;
  if (mv === 3 && sw && scripts.length === 0) {
    diags.warnings.push(
      "background: MV3 service_worker declared; Zeolite records it and boots it on demand with an idle-terminated lifecycle (see ./compat)"
    );
  }
  if (scripts.length === 0 && !page && !sw) return null;
  return { scripts, page, serviceWorker: sw, persistent };
}

function parseAction(
  manifest: Record<string, unknown>,
  mv: 2 | 3
): ActionSpec | null {
  const pick = (v: unknown, kind: ActionSpec["kind"]): ActionSpec | null => {
    if (!isObj(v)) return null;
    return {
      kind,
      defaultPopup: typeof v.default_popup === "string" ? v.default_popup : null,
      defaultTitle: typeof v.default_title === "string" ? v.default_title : null,
      defaultIcon: iconMap(v.default_icon),
      badgeText: null,
      badgeBackgroundColor: null,
      enabled: true,
    };
  };
  /* Field precedence per manifest version: MV3 leads with action,
     Firefox MV2 with browser_action; page_action is the fallback. */
  const order: ActionSpec["kind"][] =
    mv === 3 ? ["action", "browser_action", "page_action"] : ["browser_action", "action", "page_action"];
  for (const kind of order) {
    const v = manifest[kind];
    const spec = pick(v, kind);
    if (spec) return spec;
  }
  return null;
}

function parseWebAccessible(
  v: unknown,
  mv: 2 | 3,
  diags: ManifestDiagnostics
): {
  globs: string[];
  scoped: Array<{
    resources: string[];
    matches: string[];
    extensionIds?: string[];
    useDynamicUrl?: boolean;
  }>;
} {
  if (Array.isArray(v)) {
    /* MV2: plain string globs. */
    if (mv === 2) return { globs: strArr(v), scoped: [] };
    /* MV3: array of { resources, matches, extension_ids, use_dynamic_url }.
       Entries with matches are scope-bound to the requesting page (#51);
       #524: entries with extension_ids are admitted to registered page
       clients of the listed extensions ("*" admits every extension);
       an entry with neither matches nor extension_ids keeps the
       MV2-style open glob exposure, with a warning that it is not
       destination-scoped. use_dynamic_url is recorded but not
       enforced (same-origin serving has no dynamic origin to bind). */
    const globs: string[] = [];
    const scoped: Array<{
      resources: string[];
      matches: string[];
      extensionIds?: string[];
      useDynamicUrl?: boolean;
    }> = [];
    for (const e of objArr(v)) {
      const res = strArr(e.resources);
      if (res.length === 0) {
        diags.warnings.push("web_accessible_resources: MV3 entry without resources ignored");
        continue;
      }
      const matches = strArr(e.matches);
      const extensionIds = strArr(e.extension_ids);
      const useDynamicUrl = e.use_dynamic_url === true;
      if (matches.length === 0 && extensionIds.length === 0) {
        diags.warnings.push("web_accessible_resources: MV3 entry without matches exposed by glob only");
        globs.push(...res);
      } else {
        scoped.push({
          resources: res,
          matches,
          ...(extensionIds.length > 0 ? { extensionIds } : {}),
          ...(useDynamicUrl ? { useDynamicUrl } : {}),
        });
        if (useDynamicUrl) {
          diags.warnings.push(
            "web_accessible_resources: use_dynamic_url recorded but not enforced (same-origin serving has no dynamic origin to bind)",
          );
        }
      }
    }
    return { globs, scoped };
  }
  return { globs: [], scoped: [] };
}

export function parseManifest(
  raw: unknown
): { ok: boolean; parsed: ParsedExtension | null; diags: ManifestDiagnostics } {
  const diags: ManifestDiagnostics = { errors: [], warnings: [], unsupportedFields: [] };
  if (!isObj(raw)) {
    diags.errors.push("manifest.json: root is not a JSON object");
    return { ok: false, parsed: null, diags };
  }
  const mvRaw = raw.manifest_version;
  if (mvRaw !== 2 && mvRaw !== 3) {
    diags.errors.push("manifest_version: must be 2 or 3 (got " + String(mvRaw) + ")");
    return { ok: false, parsed: null, diags };
  }
  const mv: 2 | 3 = mvRaw;

  const name = typeof raw.name === "string" ? raw.name : "";
  const version = typeof raw.version === "string" ? raw.version : "";
  if (!name) diags.errors.push("name: required non-empty string");
  if (!version) diags.errors.push("version: required string");
  if (!/^\d+(\.\d+)*/.test(version)) {
    diags.warnings.push("version: '" + version + "' does not start as digits.digits");
  }

  const permissionsAll = strArr(raw.permissions);
  const hostPermissions = strArr(raw.host_permissions)
    .concat(permissionsAll.filter(looksLikeHostPattern));
  const permissions = permissionsAll.filter((p) => !looksLikeHostPattern(p));

  const bss = isObj(raw.browser_specific_settings)
    ? (raw.browser_specific_settings as Record<string, unknown>)
    : isObj(raw.applications)
      ? (raw.applications as Record<string, unknown>)
      : null;
  const gecko = bss && isObj(bss.gecko) ? (bss.gecko as Record<string, unknown>) : null;
  const geckoId = gecko && typeof gecko.id === "string" ? gecko.id : null;
  /* #524: browser_specific_settings.gecko validation. A malformed id is
     a Firefox-style hard error; malformed version bounds warn (the
     engine records but does not enforce Gecko version ranges); engine
     keys other than gecko/gecko_android have no Zeolite support. */
  if (geckoId !== null && !validGeckoId(geckoId)) {
    diags.errors.push(
      "browser_specific_settings.gecko.id: '" + geckoId + "' is not a valid extension ID (a GUID like {12345678-...} or an id like add-on@example.org)",
    );
  }
  if (gecko) {
    for (const k of Object.keys(gecko)) {
      if (k !== "id" && k !== "strict_min_version" && k !== "strict_max_version" && k !== "update_url") {
        diags.warnings.push("browser_specific_settings.gecko: unsupported key '" + k + "' ignored");
      }
    }
  }
  if (bss) {
    for (const engine of Object.keys(bss)) {
      if (engine !== "gecko" && engine !== "gecko_android") {
        diags.warnings.push("browser_specific_settings: engine '" + engine + "' has no Zeolite support, ignored");
      }
    }
  }
  /* Firefox-legal non-dotted bounds like "128.*" are recorded as-is
     with a warning; dropping the value would lose manifest truth, and
     the engine does not enforce Gecko version ranges anyway. */
  const geckoMinVersion =
    gecko && typeof gecko.strict_min_version === "string" && gecko.strict_min_version.length > 0
      ? gecko.strict_min_version
      : null;
  const geckoMaxVersion =
    gecko && typeof gecko.strict_max_version === "string" && gecko.strict_max_version.length > 0
      ? gecko.strict_max_version
      : null;
  if (gecko?.strict_min_version !== undefined && dottedVersion(gecko.strict_min_version) === null) {
    diags.warnings.push("browser_specific_settings.gecko.strict_min_version: '" + String(gecko.strict_min_version) + "' is not a dotted version, recorded as-is");
  }
  if (gecko?.strict_max_version !== undefined && dottedVersion(gecko.strict_max_version) === null) {
    diags.warnings.push("browser_specific_settings.gecko.strict_max_version: '" + String(gecko.strict_max_version) + "' is not a dotted version, recorded as-is");
  }
  /* #524: static theme (Firefox "theme" key) parsed and recorded; the
     engine has no theme host, so nothing consumes it yet. */
  const themeRaw = isObj(raw.theme) ? (raw.theme as Record<string, unknown>) : null;
  const theme = themeRaw
    ? {
        colors: isObj(themeRaw.colors) ? { ...(themeRaw.colors as Record<string, unknown>) } : {},
        images: isObj(themeRaw.images) ? { ...(themeRaw.images as Record<string, unknown>) } : {},
      }
    : null;
  /* #524: dictionaries map locale -> spellcheck dictionary path;
     recorded for the host, no spellcheck integration yet. */
  const dictionaries = isObj(raw.dictionaries)
    ? Object.fromEntries(
        Object.entries(raw.dictionaries as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : null;
  if (raw.dictionaries !== undefined && dictionaries !== null && Object.keys(dictionaries).length === 0) {
    diags.warnings.push("dictionaries: no usable locale -> path entries");
  }

  const optionsUi = isObj(raw.options_ui)
    ? (raw.options_ui as Record<string, unknown>)
    : null;
  const options: OptionsSpec | null = optionsUi
    ? {
        page: typeof optionsUi.page === "string" ? optionsUi.page : "",
        openInTab: optionsUi.open_in_tab === true,
      }
    : typeof raw.options_page === "string"
      ? { page: raw.options_page, openInTab: true }
      : null;
  if (options && !options.page) {
    diags.warnings.push("options: page path missing");
  }

  const ecRaw = isObj(raw.externally_connectable) ? raw.externally_connectable : null;
  const externallyConnectable: ExternallyConnectableSpec | null = ecRaw
    ? { ids: strArr(ecRaw.ids), matches: strArr(ecRaw.matches) }
    : null;

  const cspRaw = raw.content_security_policy;
  const csp =
    typeof cspRaw === "string"
      ? cspRaw
      : isObj(cspRaw) && typeof cspRaw.extension_pages === "string"
        ? cspRaw.extension_pages
        : null;

  const sidebarRaw = isObj(raw.sidebar_action) ? raw.sidebar_action : null;
  const sidebarAction: SidebarActionSpec | null = sidebarRaw
    ? {
        defaultPanel: typeof sidebarRaw.default_panel === "string" ? sidebarRaw.default_panel : null,
        defaultTitle: typeof sidebarRaw.default_title === "string" ? sidebarRaw.default_title : null,
        defaultIcon: iconMap(sidebarRaw.default_icon),
      }
    : null;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) diags.unsupportedFields.push(key);
  }

  /* #51: WAR globs and MV3 matches-scoped entries are tracked
     separately; see getResource's fromWeb gate. */
  const war = parseWebAccessible(raw.web_accessible_resources, mv, diags);
  const parsed: ParsedExtension = {
    name,
    version,
    manifestVersion: mv,
    manifest: raw,
    geckoId,
    geckoMinVersion,
    geckoMaxVersion,
    theme,
    dictionaries,
    permissions,
    hostPermissions,
    optionalPermissions: strArr(raw.optional_permissions),
    contentScripts: parseContentScripts(raw.content_scripts, diags),
    background: parseBackground(raw.background, mv, diags),
    action: parseAction(raw, mv),
    options,
    icons: iconMap(raw.icons),
    webAccessibleResources: war.globs,
    webAccessibleScoped: war.scoped,
    externallyConnectable,
    commands: isObj(raw.commands) ? (raw.commands as Record<string, unknown>) : {},
    contentSecurityPolicy: csp,
    sidebarAction,
    unsupportedFields: diags.unsupportedFields,
    warnings: diags.warnings,
  };
  return { ok: diags.errors.length === 0, parsed, diags };
}


/* #504: Chrome and Firefox resolve __MSG_<name>__ placeholders in
   manifest strings against _locales/<locale>/messages.json. The
   engine's honest equivalent is the manifest's own default_locale
   (the browser UI locale is not observable from a worker). Resolves
   the surfaced name and description in place, on the parsed record
   and the raw manifest copy the detail surfaces read; an unresolved
   placeholder (missing file, missing key, bad JSON) keeps its
   literal bytes and reports one warning per field. Message-name
   substitution only: $placeholder$ variables inside the message
   text are left as written (extName-class fields do not use them).
   Identity is untouched: the digest is over package bytes, so i18n
   resolution never changes the extension id.

   #523: the substituted field set now covers the user-visible
   surface beyond name/description - short_name, the action family's
   default_title (raw blocks and the parsed precedence winner),
   sidebar_action.default_title, and commands descriptions. Message
   names fold case-insensitively, as Chrome folds them at runtime.
   #523: Firefox rejects a manifest that uses __MSG_*__ without a
   default_locale; that is a hard install error here too. A missing
   file or key stays a warning with the literal kept (the engine's
   documented lenience for real-world packages). */
export function resolveManifestI18n(
  raw: Record<string, unknown>,
  parsed: ParsedExtension,
  readFile: (path: string) => Uint8Array | undefined,
  diags: ManifestDiagnostics,
): void {
  const locale = typeof raw.default_locale === "string" ? raw.default_locale : "";
  /* Cached folded view of the default_locale messages: keys lowercase,
     values kept raw (string shorthand or {message}). */
  let folded: Record<string, unknown> | null = null;
  let looked = false;
  const loadMessages = (): Record<string, unknown> | null => {
    if (looked) return folded;
    looked = true;
    if (!locale) return null;
    for (const p of ["_locales/" + locale + "/messages.json", "/_locales/" + locale + "/messages.json"]) {
      const bytes = readFile(p);
      if (!bytes) continue;
      try {
        const v = JSON.parse(new TextDecoder().decode(bytes));
        if (isObj(v)) {
          const f: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v)) f[k.toLowerCase()] = val;
          folded = f;
        }
      } catch {
        folded = null;
      }
      break;
    }
    return folded;
  };
  const sub = (value: string): { text: string; unresolved: boolean } => {
    if (!value.includes("__MSG_")) return { text: value, unresolved: false };
    const messages = loadMessages();
    if (!messages) return { text: value, unresolved: true };
    let unresolved = false;
    const text = value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (full, key: string): string => {
      const entry = messages[key.toLowerCase()];
      const msg =
        isObj(entry) && typeof (entry as Record<string, unknown>).message === "string"
          ? (entry as Record<string, unknown>).message as string
          : typeof entry === "string"
            ? entry
            : null;
      if (msg === null) {
        unresolved = true;
        return full;
      }
      return msg;
    });
    return { text, unresolved };
  };
  const apply = (label: string, value: string, set: (t: string) => void): void => {
    if (!value.includes("__MSG_")) return;
    if (!locale) {
      diags.errors.push(
        label + ": __MSG_*__ placeholder used without a default_locale (Firefox rejects such manifests)",
      );
      return;
    }
    const r = sub(value);
    if (r.unresolved) {
      diags.warnings.push(
        label + ": __MSG_*__ placeholder could not be resolved from _locales/" + locale + "; the literal placeholder is kept",
      );
    } else {
      set(r.text);
    }
  };
  apply("name", parsed.name, (t) => {
    parsed.name = t;
  });
  if (typeof raw.description === "string") {
    apply("description", raw.description, (t) => {
      raw.description = t;
    });
  }
  if (typeof raw.short_name === "string") {
    apply("short_name", raw.short_name, (t) => {
      raw.short_name = t;
    });
  }
  /* The action family: every raw block is substituted (manifest
     truth), and the parsed precedence winner so the record surfaces
     the resolved title. */
  for (const key of ["action", "browser_action", "page_action"]) {
    const block = isObj(raw[key]) ? (raw[key] as Record<string, unknown>) : null;
    if (block && typeof block.default_title === "string") {
      apply(key + ".default_title", block.default_title, (t) => {
        block.default_title = t;
      });
    }
  }
  if (parsed.action?.defaultTitle && parsed.action.defaultTitle.includes("__MSG_")) {
    apply("action.default_title", parsed.action.defaultTitle, (t) => {
      parsed.action!.defaultTitle = t;
    });
  }
  const sidebarBlock = isObj(raw.sidebar_action) ? (raw.sidebar_action as Record<string, unknown>) : null;
  if (sidebarBlock && typeof sidebarBlock.default_title === "string") {
    apply("sidebar_action.default_title", sidebarBlock.default_title, (t) => {
      sidebarBlock.default_title = t;
    });
  }
  if (parsed.sidebarAction?.defaultTitle && parsed.sidebarAction.defaultTitle.includes("__MSG_")) {
    apply("sidebar_action.default_title", parsed.sidebarAction.defaultTitle, (t) => {
      parsed.sidebarAction!.defaultTitle = t;
    });
  }
  const commands = isObj(raw.commands) ? (raw.commands as Record<string, unknown>) : null;
  if (commands) {
    for (const [name, c] of Object.entries(commands)) {
      if (isObj(c) && typeof (c as Record<string, unknown>).description === "string") {
        apply(
          "commands." + name + ".description",
          (c as Record<string, unknown>).description as string,
          (t) => {
            (c as Record<string, unknown>).description = t;
          },
        );
      }
    }
  }
}