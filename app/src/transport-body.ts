/* #556: the one transport-proven request-body shape.

   The vendored wasm artifact refuses File/Blob bodies (its socket
   plumbing throws) and full-buffers whatever it does carry into the
   wasm heap; measured through the engine, an 8 MiB body rides while
   a 16 MiB body kills the renderer process. Every wisp dispatch
   therefore materializes a Blob/File body as ONE bounded ArrayBuffer
   copy before the artifact sees it, and fails honestly over the
   bound instead of crashing the renderer.

   The relay path (#556 relay follow-up) is exempt by design: a
   File body crosses the registered relay port by structured clone
   and the embedder carries it upstream with its own stack, so the
   spool cap (not this bound) governs relayed uploads. Leaf module on
   purpose: request.ts and transport.ts both import it without a
   cycle. */

import { DIAG } from "./diag";

/** Measured ceiling for one request body through the vendored
    artifact (16 MiB kills the renderer, 8 MiB rides). */
export const TRANSPORT_BODY_BOUND = 8 * 1024 * 1024;

/** #556: materialize init.body in place when it is a Blob/File:
    bounded copy under TRANSPORT_BODY_BOUND, honest error over it.
    Non-Blob bodies pass through untouched. Exported for the
    replay-body regression tests. */
export async function materializeBlobBody(init: { body?: BodyInit | null }): Promise<void> {
  const b = init.body;
  if (!(b instanceof Blob)) return;
  if (b.size > TRANSPORT_BODY_BOUND) {
    DIAG.emit({
      category: "TRANSPORT",
      severity: "warning",
      message: "blob body over the transport body bound; serving the honest error strand",
    });
    throw new Error(
      "zeolite: request body exceeds the transport body bound; streaming uploads need transport streaming support",
    );
  }
  init.body = await b.arrayBuffer();
}
