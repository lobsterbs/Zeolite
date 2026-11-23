/* #708: a gemini batchexecute reply refuses an rpc by answering
   HTTP 200 with a batched frame whose wrb.fr item carries a null
   payload and a numeric status instead of data. No status gate,
   error beacon or rewrite pass ever fires on that, so dead
   interactions were invisible in a KDL export. This module only
   recognizes the observed refusal shape (pin-192 conviction); a
   refusal emitted in an unknown shape stays silent, which is the
   right trade for a bounded diagnostic. */

export interface WrbRefusal {
  /** The rpc name from the refused wrb.fr item (e.g. "MI613e"). */
  rpc: string;
  /** The status carried by the item (e.g. 13). */
  status: number;
}

export function isBatchexecuteUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/batchexecute");
  } catch {
    return false;
  }
}

/* ponytail: plain regex over a bounded body prefix, not a JSON parse -
   batchexecute frames open with an XSSI prelude, and a false match
   inside an escaped payload string only ever produces a diagnostic row. */
const WRB_REFUSAL_RE = /"wrb\.fr","([^"]{1,48})",null,null,null,\[(\d{1,3})\]/g;

export function parseWrbRefusals(prefix: string): WrbRefusal[] {
  const out: WrbRefusal[] = [];
  const re = new RegExp(WRB_REFUSAL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) {
    out.push({ rpc: m[1]!, status: Number(m[2]) });
    if (out.length >= 12) break;
  }
  return out;
}

export function formatWrbRefusals(refusals: WrbRefusal[]): string {
  const head = refusals.slice(0, 4).map((r) => r.rpc + "(" + r.status + ")");
  const rest = refusals.length - head.length;
  return head.join(",") + (rest > 0 ? ",+" + rest + "more" : "");
}
