# Browser torture wedge: occurrence record for run 1864

Run 44753942808 (run 1864, 2026-11-20, head 36932d2, the #697
storage-parity ship). Single-victim occurrence: the only red probe
in the entire run was the ~2 MB streamed large-document probe
("first marker never rendered in 60s", embedder "Starting
engine...") - the variant already recorded in
docs/ci-torture-wedge.md for the 2026-11-13/15 heads; no cascade
beyond it. The browser E2E block in the same job passed 74/74
first.

Exoneration of the head: 36932d2 touches only
app/src/extensions/storage.ts and its tests (storage get omits
never-set keys instead of null entries). The extensions storage
area is domain-disjoint from the wisp transport seam and the
rewriting pump that the large-document probe exercises. wasm,
rust, compat and the app bundle job (which published build
44753942808 to dist before torture started) were all green.

Per the operational notes in docs/ci-torture-wedge.md, this
record doubles as the cheapest legitimate retrigger; pin 185 of
LobsterBrowse waits for the all-green rerun per the pin gate.
