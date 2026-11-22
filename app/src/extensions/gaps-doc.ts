/* Zeolite extension subsystem: the human-readable gap report (#516).

   docs/firefox-api-gaps.md is GENERATED from the same machine-readable
   facts the conformance tests hold fresh: firefoxGapReport() over the
   real mounted surface. The staleness test (gaps-doc.test.ts) renders
   this function and compares it against the committed file, so the
   document cannot drift from the inventory - CI fails when a slice
   changes the mounted surface or the gap tables without regenerating
   the doc. Regenerate with:
     ZL_UPDATE_GAPS_DOC=1 npx vitest run src/extensions/__tests__/gaps-doc.test.ts
   from app/. */

import { FIREFOX_MEMBER_GAP_REASONS, type FirefoxGapReport } from "./firefox-inventory";
import type { InventoryNamespace } from "./inventory";

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Render the gap report (plus the mounted-surface summary) as the
    committed markdown document. */
export function renderGapsDoc(report: FirefoxGapReport, mounted: InventoryNamespace[]): string {
  const lines: string[] = [];
  const memberCount = mounted.reduce((n, ns) => n + ns.members.length, 0);
  lines.push("<!-- GENERATED FILE - edit the generator (app/src/extensions/gaps-doc.ts), not this file. -->");
  lines.push("");
  lines.push("# Firefox WebExtensions API gap report");
  lines.push("");
  lines.push(
    "Generated from the same machine-readable facts the conformance tests hold fresh: `firefoxGapReport()` over the real mounted surface ([firefox-inventory.ts](../app/src/extensions/firefox-inventory.ts), issue #516). The staleness test [gaps-doc.test.ts](../app/src/extensions/__tests__/gaps-doc.test.ts) renders this document and compares it against the committed file, so it cannot drift from the inventory.",
  );
  lines.push("");
  lines.push("Regenerate after any slice that changes the mounted surface or the gap tables:");
  lines.push("");
  lines.push("```");
  lines.push("ZL_UPDATE_GAPS_DOC=1 npx vitest run src/extensions/__tests__/gaps-doc.test.ts   # from app/");
  lines.push("```");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Mounted namespaces: **${mounted.length}** (${memberCount} members), the union of the action-family fixtures`);
  lines.push(`- Firefox namespaces not mounted: **${report.absentNamespaces.length}**, each with its honest reason`);
  lines.push(`- Mounted namespaces with member-level gaps: **${report.missingMembers.length}**`);
  lines.push(`- Engine extras (mounted members Firefox does not have): **${report.engineExtras.length}**, each justified in COMPAT`);
  lines.push("");
  lines.push("The wave issues #517-#524 diff against this baseline; a namespace that gains an implementation removes its reason from `FIREFOX_UNMOUNTED_REASONS` and this document regenerates with it gone.");
  lines.push("");
  lines.push("## Firefox namespaces the engine does not mount");
  lines.push("");
  lines.push("| Namespace | Reason |");
  lines.push("| --- | --- |");
  for (const a of report.absentNamespaces) {
    lines.push(`| \`${esc(a.name)}\` | ${esc(a.reason)} |`);
  }
  lines.push("");
  lines.push("## Member-level gaps inside mounted namespaces");
  lines.push("");
  if (report.missingMembers.length === 0) {
    lines.push("None - every mounted namespace carries every Firefox member its inventory declares.");
  } else {
    lines.push("| Namespace | Member | Reason |");
    lines.push("| --- | --- | --- |");
    for (const m of report.missingMembers) {
      for (const member of m.members) {
        lines.push(
          "| `" + esc(m.namespace) + "` | `" + esc(member) + "` | " + esc(FIREFOX_MEMBER_GAP_REASONS[m.namespace + "." + member]) + " |",
        );
      }
    }
  }
  lines.push("");
  lines.push("## Engine extras (mounted members Firefox does not have)");
  lines.push("");
  lines.push("| Member | Reason |");
  lines.push("| --- | --- |");
  for (const e of report.engineExtras) {
    lines.push(`| \`${esc(e.namespace)}.${esc(e.member)}\` | ${esc(e.reason)} |`);
  }
  lines.push("");
  lines.push("## Mounted surface");
  lines.push("");
  lines.push("| Namespace | Members |");
  lines.push("| --- | --- |");
  for (const ns of mounted) {
    lines.push(`| \`${esc(ns.name)}\` | ${ns.members.map((m) => `\`${esc(m.name)}\` (${m.kind})`).join(", ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
