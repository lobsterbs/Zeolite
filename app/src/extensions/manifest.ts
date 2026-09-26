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
]);

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
): string[] {
  if (Array.isArray(v)) {
    /* MV2: plain string globs. */
    if (mv === 2) return strArr(v);
    /* MV3: array of { resources, matches, extension_ids }. */
    const out: string[] = [];
    for (const e of objArr(v)) {
      const res = strArr(e.resources);
      if (res.length === 0) {
        diags.warnings.push("web_accessible_resources: MV3 entry without resources ignored");
      }
      out.push(...res);
    }
    return out;
  }
  return [];
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

  const parsed: ParsedExtension = {
    name,
    version,
    manifestVersion: mv,
    manifest: raw,
    geckoId,
    permissions,
    hostPermissions,
    optionalPermissions: strArr(raw.optional_permissions),
    contentScripts: parseContentScripts(raw.content_scripts, diags),
    background: parseBackground(raw.background, mv, diags),
    action: parseAction(raw, mv),
    options,
    icons: iconMap(raw.icons),
    webAccessibleResources: parseWebAccessible(raw.web_accessible_resources, mv, diags),
    externallyConnectable,
    commands: isObj(raw.commands) ? (raw.commands as Record<string, unknown>) : {},
    contentSecurityPolicy: csp,
    sidebarAction,
    unsupportedFields: diags.unsupportedFields,
    warnings: diags.warnings,
  };
  return { ok: diags.errors.length === 0, parsed, diags };
}
