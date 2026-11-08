/* Strict privacy mode (#550 ship 2). One boolean, memory only: a
   worker restart clears it and the host page (the only sender that
   can reach zl:privacy, the #41 gate keeps it out of PAGE_MESSAGES)
   re-declares its intent. When strict, the control plane refuses
   every diagnostic surface that can name pages, URLs or page content:
   the Tier 2 inspector, the network log, the diagnostics ring, the
   request-scoped exporter and the captcha trace. The toggle itself is
   never refused, so the host can always leave the mode. */

/** The devtools surfaces strict mode refuses (data, not a switch). */
export const STRICT_REFUSED: ReadonlySet<string> = new Set([
  "zl:domInspect",
  "zl:getNetLog",
  "zl:getDiag",
  "zl:exportDiagnostics",
  "zl:captchaTrace",
]);

let strict = false;

export function isStrictPrivacy(): boolean {
  return strict;
}

export function setStrictPrivacy(v: boolean): void {
  strict = v === true;
}

/** Tests only. */
export function privacyResetForTests(): void {
  strict = false;
}
