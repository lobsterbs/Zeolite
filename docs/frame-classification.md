# Content-script frame classification

A declared content script without `all_frames` runs only in the
frame the browser considers its main browsing surface. Zeolite
serves every proxied document inside a frame the network layer
labels `sec-fetch-dest: iframe`, so the request engine classifies
frames itself instead of trusting that label:

- A frame whose parent is a host-app page (a URL on neither a NAVH
  route nor an engine route) is the browsing pane's main surface.
  Declared scripts run there exactly as in a top-level document.
- A frame whose parent is itself a proxied document (NAVH or engine
  route) keeps native subframe semantics: only `all_frames` specs
  run there.
- An absent, `about:`, or unparseable parent referrer fails closed
  to subframe semantics.

Gated by app/src/extensions/__tests__/cs-inject.test.ts.
