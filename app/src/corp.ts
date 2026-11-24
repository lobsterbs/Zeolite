/* Cross-Origin-Resource-Policy parity for COEP embedders.

   A split-origin host that runs COOP/COEP on its top document
   (crossOriginIsolation for SharedArrayBuffer and friends) only
   embeds cross-origin frame documents that opt into embedding:
   without CORP the browser blocks the frame load with
   ERR_BLOCKED_BY_RESPONSE and the embedder sees an empty
   chrome-error frame instead of the proxied page. The content
   origin serves those frame documents, so every response the
   engine hands back through respondWith must carry
   CORP: cross-origin (the origin server adds it to its own
   responses; this covers the worker-served ones). Applied at the
   single respondWith seam in sw.ts, so whatever internal path
   built the response - rewrite stream, redirect, honest error
   page, cache hit - the embedder sees an embeddable response.

   COI parity (the coi zl:config arm, ./swstate): when armed, the
   same rebuild also stamps COEP: credentialless, so proxied frame
   documents join the isolated deployment's agent cluster and pages
   can reach SharedArrayBuffer. credentialless (not require-corp)
   on purpose: no-cors passthroughs (opaque responses keep their
   native object below) then load without CORP, and browsers that
   ignore the value degrade to today's non-isolated behavior.

   Honest limits: opaque, opaqueredirect and error responses keep
   their native object (headers are immutable and the body of an
   opaque response is unreadable); those are no-cors passthroughs
   for cross-origin subresources, which a COEP embedder's pages
   already load through the engine. */

import { coiEnabled } from "./swstate";

export function withCorp(r: Response): Response {
  if (!r || (r.type !== "default" && r.type !== "cors")) return r;
  try {
    const h = new Headers(r.headers);
    h.set("cross-origin-resource-policy", "cross-origin");
    if (coiEnabled()) {
      h.set("cross-origin-embedder-policy", "credentialless");
    }
    return new Response(r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: h,
    });
  } catch {
    /* A response that cannot be rebuilt (locked body, forbidden
       status) keeps its native form; the passthrough is honest. */
    return r;
  }
}
