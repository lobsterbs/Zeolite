# Final integration scout (PR #480)

Zeolite remains experimental. This pass reconciles main's anchor and embed
recovery fixes with the unmerged transport/diagnostics PR.

## Confirmed and addressed

- #497: the combined bootstrap was 41,566 bytes. Reuse one bounded control
  query lifecycle, retain node-associated anchor results, compact reflection
  descriptors, and use native base64 over iterative UTF-8 bytes. The unchanged
  gate is 39,424 bytes; the resulting production bootstrap is 39,417 bytes.
- #498: failed/malformed embedder replies no longer authorize native popup
  fallback. Only a successful reply with explicit null origin means standalone.
  Timeout/send failure retries remain bounded at four attempts; each query
  re-resolves the controller, closes both local ports, clears its timer and
  ignores stale callbacks. Failed-attempt queued popups are dropped.
- Retain both prior regression sets: 600 absolute anchors, 300 relative pairs,
  href mutations, explicit evicted-route reads, component/stringifier reflection,
  channel teardown, and correct WebSocket state/byte semantics. The older
  main-branch test incorrectly expecting CONNECTING send queuing was corrected.

## Validation and limits

The combined app suite passed 1,798 tests across 176 files, with typecheck and
production build. This is not proof of live Startpage/Claude compatibility.
Full guest execution, complete CSP translation, authenticated vendor WISP,
network drain and live-site reproductions remain separate open acceptance work.
Nothing in this pass changes detector behavior, fabricates browser identity,
merges the PR or deploys the engine.
