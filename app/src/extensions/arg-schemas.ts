/* Zeolite extension subsystem: argument schemas + validation (#516,
   slice 3).

   #516 slice 2 made the mounted surface self-describing against
   Firefox member by member; this slice adds the argument contract.
   ARG_SCHEMAS is a machine-readable table for the first five
   namespaces (alarms, cookies, runtime, storage, tabs): per mounted
   method, the accepted argument count and the JS kind every position
   may carry. installArgValidation() wraps the mounted methods so
   out-of-contract calls reject with a TypeError before any engine
   work happens, and the conformance test (arg-schemas.test.ts)
   enforces that the table covers every mounted method of those five
   namespaces 1:1 - a new method without a schema fails CI.

   The table describes the MOUNTED contract (what the engine really
   accepts today). Where that deliberately differs from Firefox's
   schema signature, `ff` carries Firefox's [minArgs, maxArgs] (from
   the @types/firefox-webext-browser 143.0.1 signatures) and `note`
   says why the engine shape differs - deviations stay visible, never
   silent. Nested storage areas are keyed by dotted path
   (storage.local.get). Honest gaps that remain open for later slices:
   Firefox's StorageArea.getKeys is not mounted (recorded here, feeds
   #520), the remaining namespaces get schemas in follow-up slices,
   and return-value/enum validation is not covered yet. */

export type ArgKind = "string" | "number" | "boolean" | "object" | "array" | "function" | "null" | "any";

export interface ArgSchema {
  /** Inclusive minimum argument count. */
  min: number;
  /** Inclusive maximum argument count. */
  max: number;
  /** Allowed kinds per position (index-aligned); null skips the
      check for that position. Shorter than args: trailing positions
      are unchecked. */
  types?: (ArgKind[] | null)[];
  /** Firefox's [minArgs, maxArgs] when the mounted shape differs. */
  ff?: [number, number];
  /** Why the mounted shape differs from Firefox's signature. */
  note?: string;
}

/** The mounted argument contract, per dotted member path. */
export const ARG_SCHEMAS: Record<string, ArgSchema> = {
  /* ---- alarms -------------------------------------------------------- */
  "alarms.create": {
    min: 1,
    max: 2,
    types: [["string", "object"], ["object"]],
    /* Firefox: create(alarmInfo) | create(name, alarmInfo) */
  },
  "alarms.get": { min: 0, max: 1, types: [["string"]] },
  "alarms.getAll": { min: 0, max: 0 },
  "alarms.clear": { min: 0, max: 1, types: [["string"]] },
  "alarms.clearAll": { min: 0, max: 0 },

  /* ---- cookies --------------------------------------------------------- */
  /* Firefox requires the details object on all four; the engine
     mounts the no-arg form (it rejects honestly inside the call for
     the shapes that need details). */
  "cookies.get": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },
  "cookies.getAll": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (all cookies of the active profile)" },
  "cookies.set": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },
  "cookies.remove": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },

  /* ---- runtime --------------------------------------------------------- */
  "runtime.connect": {
    min: 0,
    max: 2,
    types: [["string", "object"], ["object"]],
    /* Firefox: connect() | connect(connectInfo) | connect(extensionId, connectInfo?) */
  },
  "runtime.getBrowserInfo": { min: 0, max: 0 },
  /* Firefox: getContexts(filter) with a required ContextFilter; the
     engine mounts the no-filter form (every live context of the
     extension), so a filter argument is refused instead of silently
     ignored. */
  "runtime.getContexts": { min: 0, max: 0, ff: [1, 1], note: "the engine mounts the no-filter form; Firefox's ContextFilter is not accepted" },
  "runtime.getManifest": { min: 0, max: 0 },
  "runtime.getPlatformInfo": { min: 0, max: 0 },
  "runtime.getURL": { min: 1, max: 1, types: [["string"]] },
  "runtime.openOptionsPage": { min: 0, max: 0 },
  "runtime.reload": { min: 0, max: 0 },
  /* Firefox adds sendMessage(extensionId, message, options?) - the
     engine has no options argument. Positions stay unchecked: both
     the (message) and (extensionId, message) overloads are live. */
  "runtime.sendMessage": { min: 1, max: 2, ff: [1, 3], note: "the engine does not accept Firefox's options argument" },

  /* ---- storage areas ----------------------------------------------------- */
  /* Firefox's StorageArea also declares getKeys(); the engine does
     not mount it yet (feeds #520). getBytesInUse is Firefox-deprecated
     but mounted for Chrome parity. */
  "storage.local.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.local.set": { min: 1, max: 1, types: [["object"]] },
  "storage.local.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.local.clear": { min: 0, max: 0 },
  "storage.local.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  "storage.sync.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.sync.set": { min: 1, max: 1, types: [["object"]] },
  "storage.sync.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.sync.clear": { min: 0, max: 0 },
  "storage.sync.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  "storage.session.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.session.set": { min: 1, max: 1, types: [["object"]] },
  "storage.session.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.session.clear": { min: 0, max: 0 },
  "storage.session.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  /* Firefox documents the plain-string form; Chrome's {accessLevel}
     object form is accepted too (storage.ts setSessionAccessLevel). */
  "storage.session.setAccessLevel": { min: 1, max: 1, types: [["string", "object"]] },

  /* ---- tabs --------------------------------------------------------------- */
  "tabs.create": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty active tab)" },
  "tabs.get": { min: 1, max: 1, types: [["number"]] },
  "tabs.getCurrent": { min: 0, max: 0 },
  "tabs.query": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (all tabs visible to the extension)" },
  "tabs.remove": { min: 1, max: 1, types: [["number", "array"]] },
  "tabs.sendMessage": { min: 2, max: 3, types: [["number"], ["any"], ["object"]] },
  /* Firefox: update(updateProperties) | update(tabId, updateProperties);
     the engine mounts the no-tab form (the single-window model). */
  "tabs.update": { min: 0, max: 2, types: [["number", "object"], ["object"]], ff: [1, 2], note: "the engine also mounts the no-tab form" },
};

/** Classify one argument value into the table's kind vocabulary. */
export function argKindOf(v: unknown): ArgKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as ArgKind;
}

/** Reject out-of-contract calls with a precise TypeError. The arity
    check runs first, so a too-many/too-few call never also reports a
    type complaint. */
export function validateArgs(path: string, schema: ArgSchema, args: unknown[]): void {
  if (args.length < schema.min) {
    throw new TypeError(`zeolite: ${path}: expected at least ${schema.min} argument(s), got ${args.length}`);
  }
  if (args.length > schema.max) {
    throw new TypeError(`zeolite: ${path}: expected at most ${schema.max} argument(s), got ${args.length}`);
  }
  const types = schema.types;
  if (!types) return;
  for (let i = 0; i < args.length && i < types.length; i++) {
    const allowed = types[i];
    if (!allowed || allowed.includes("any")) continue;
    /* Standard optional-argument semantics: an explicit undefined at
       an optional position (i >= min) means "omitted" - real callers
       write f(id, undefined) - while undefined at a required position
       still fails the kind check, as Firefox's schema would. */
    if (args[i] === undefined && i >= schema.min) continue;
    const kind = argKindOf(args[i]);
    if (!allowed.includes(kind)) {
      throw new TypeError(`zeolite: ${path}: argument ${i + 1} must be ${allowed.join(" | ")}, got ${kind}`);
    }
  }
}

/** Wrap every mounted method named by ARG_SCHEMAS so out-of-contract
    calls reject before the engine runs. Paths whose namespace or
    member is not mounted (permission-gated away, or an area the
    context lacks) are skipped silently - the conformance test holds
    the table to the mounted surface 1:1, so a skipped path that
    should mount fails CI there instead. */
export function installArgValidation(api: Record<string, unknown>): void {
  for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
    const parts = path.split(".");
    let parent: Record<string, unknown> | undefined = api;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = parent?.[parts[i]];
      if (typeof next !== "object" || next === null) {
        parent = undefined;
        break;
      }
      parent = next as Record<string, unknown>;
    }
    if (!parent) continue;
    const key = parts[parts.length - 1];
    const fn = parent[key];
    if (typeof fn !== "function") continue;
    parent[key] = (...args: unknown[]): unknown => {
      validateArgs(path, schema, args);
      return (fn as (...a: unknown[]) => unknown).apply(parent, args);
    };
  }
}
