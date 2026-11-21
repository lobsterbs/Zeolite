/* Zeolite extension subsystem: content-script matching.

   Implements the Firefox grammar: match patterns, exclude_matches,
   include/exclude globs, run_at, all_frames. This module resolves
   which scripts would run on a given URL and frame; the execution hook
   into the sw.ts injection pipeline lands with the background runtime
   phase, so nothing here fakes execution. */

import type { ContentScriptSpec, ExtensionId, ExtensionRecord } from "./types";
import { REGISTRATIONS } from "./registrations";
import { hostPatternsMatch } from "./permissions";

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+?^{}()|[\]\\$]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}

export function contentScriptMatches(
  spec: ContentScriptSpec,
  url: string,
  isSubframe: boolean
): boolean {
  if (!spec.all_frames && isSubframe) return false;
  if (!hostPatternsMatch(spec.matches, url)) return false;
  if (spec.exclude_matches.length > 0 && hostPatternsMatch(spec.exclude_matches, url)) {
    return false;
  }
  if (spec.include_globs.length > 0) {
    const hit = spec.include_globs.some((g) => globToRegExp(g).test(url));
    if (!hit) return false;
  }
  for (const g of spec.exclude_globs) {
    if (globToRegExp(g).test(url)) return false;
  }
  return true;
}

export interface ResolvedContentScripts {
  extId: ExtensionId;
  js: string[];
  css: string[];
  runAt: ContentScriptSpec["run_at"];
}

/* Which scripts (from enabled extensions) would run on this URL/frame. */
export function resolveContentScripts(
  exts: ExtensionRecord[],
  url: string,
  isSubframe: boolean
): ResolvedContentScripts[] {
  const out: ResolvedContentScripts[] = [];
  for (const ext of exts) {
    if (!ext.enabled) continue;
    for (const spec of [...ext.contentScripts, ...REGISTRATIONS.specsFor(ext.id)]) {
      if (!contentScriptMatches(spec, url, isSubframe)) continue;
      out.push({ extId: ext.id, js: spec.js, css: spec.css, runAt: spec.run_at });
    }
  }
  return out;
}
