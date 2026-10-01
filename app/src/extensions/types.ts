/* Zeolite extension subsystem: data model.

   The ExtensionRecord is the durable, complete picture of one installed
   extension: identity, parsed manifest surface, permissions, lifecycle
   state and diagnostics. Raw manifest JSON is always preserved so
   unknown or not-yet-supported fields survive installs and can be
   surfaced in diagnostics later. */

export type ExtensionId = string;

/* Lifecycle per the extension design doc. ERROR is sticky per
   extension and never propagates to the host. */
export type ExtensionState =
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopping"
  | "disabled"
  | "uninstalled"
  | "error";

export interface ContentScriptSpec {
  matches: string[];
  exclude_matches: string[];
  include_globs: string[];
  exclude_globs: string[];
  js: string[];
  css: string[];
  run_at: "document_start" | "document_end" | "document_idle";
  all_frames: boolean;
  match_about_blank: boolean;
}

export interface BackgroundSpec {
  scripts: string[];
  page: string | null;
  /* Firefox MV3 uses background scripts; a declared service worker is
     recorded (with a diagnostic) but not executed in Phase 1. */
  serviceWorker: string | null;
  persistent: boolean;
}

export interface ActionSpec {
  kind: "action" | "browser_action" | "page_action";
  defaultPopup: string | null;
  defaultTitle: string | null;
  defaultIcon: Record<string, string>;
  badgeText: string | null;
  badgeBackgroundColor: string | null;
  enabled: boolean;
}

export interface OptionsSpec {
  page: string;
  openInTab: boolean;
}

export interface ExternallyConnectableSpec {
  ids: string[];
  matches: string[];
}

export interface SidebarActionSpec {
  defaultPanel: string | null;
  defaultTitle: string | null;
  defaultIcon: Record<string, string>;
}

export interface ExtensionRecord {
  id: ExtensionId;
  name: string;
  version: string;
  manifestVersion: 2 | 3;
  manifest: Record<string, unknown>;
  geckoId: string | null;
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  contentScripts: ContentScriptSpec[];
  background: BackgroundSpec | null;
  action: ActionSpec | null;
  options: OptionsSpec | null;
  icons: Record<string, string>;
  webAccessibleResources: string[];
  /* #51: MV3 web_accessible_resources entries whose "matches" are set;
     served only when the requesting page destination matches. */
  webAccessibleScoped: Array<{ resources: string[]; matches: string[] }>;
  externallyConnectable: ExternallyConnectableSpec | null;
  commands: Record<string, unknown>;
  contentSecurityPolicy: string | null;
  sidebarAction: SidebarActionSpec | null;
  state: ExtensionState;
  enabled: boolean;
  installTime: number;
  lastError: string | null;
  unsupportedFields: string[];
  warnings: string[];
}
