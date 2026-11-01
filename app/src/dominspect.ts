/* Zeolite in-page Tier 2 DOM inspection bridge (#550) - bundle entry.

   This file is a PAGE-side artifact built to dist/dominspect.js (a
   sibling of sw.js), never imported by the service worker or the
   bootstrap: the SW attaches the compiled source to the authorize
   ctl message and the bootstrap loader (findload.ts) evaluates it
   once per document, then hands the carrying event to the handler
   that the install registers. The logic lives in dominspect-core.ts
   so the tests can drive it directly. */

import { applyDomInspect } from "./dominspect-core";

const G = window as unknown as Record<string, unknown>;
if (typeof G.__zlDomInspect !== "function") applyDomInspect(G);
