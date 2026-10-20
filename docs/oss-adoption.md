# Adopted open-source components

Record of the 2026-10-11 OSS scan adoption pass and later additions.
Two rules: nothing is shipped without a reason, and every divergence
from a reference is written down, not papered over.

## Runtime (shipped inside the service worker bundle)

- tldts (MIT; bundles the Mozilla publicsuffix list data, MPL-2.0).
  Registrable-domain computation and public-suffix lookups. Powers:
  - the cookie jar's site-for-cookies boundary (siteOfHost in
    app/src/cookies.ts): SameSite decisions use the registrable
    domain, matching the browser site key, private-section suffixes
    included (b.github.io is its own site);
  - the admission gate (RFC 6265 5.3 step 5): a Set-Cookie whose
    Domain is itself a public suffix (com, co.uk, github.io) is
    refused, the rule browsers apply. Replaces the old last-two-labels
    and dotless-only approximations.
- @ghostery/adblocker 2.20.1 (MPL-2.0). The engine's compiled
  network matcher applies Ghostery's prebuilt ads-and-tracking
  subscriptions at the same request seam as `/rules.kdl`. List fetches
  use Zeolite's Wisp transport and are restricted to Ghostery's HTTPS
  asset directory; redirects and unsuccessful statuses are rejected.
  The matcher stays in service-worker memory, refreshes
  after seven days while the worker is active, and is loaded again on
  the next matching request after a worker restart. Local host rules
  remain active while it loads or retries after a failure. This integration
  supports network decisions only; cosmetic selectors and scriptlets
  remain a separate rewrite feature. The MPL-2.0 text is included at
  `docs/licenses/MPL-2.0.txt`.
- fake-indexeddb (Apache-2.0): IndexedDB in Node for the jar and
  extension tests. Pre-existing.

## Test oracles (dev dependencies, never shipped)

- tough-cookie (BSD-3-Clause): the RFC 6265 reference implementation.
  app/src/__tests__/cookies-oracle.test.ts pins parseCookieDate to
  parseDate on a shared corpus and runs parallel jar sequences through
  CookieJar, comparing the assembled Cookie header. Documented
  deltas, both in our favor per the RFC/browsers:
  - seconds are optional in the 5.1.1 time token (tough-cookie
    requires hh:mm:ss);
  - years below 1601 are rejected (tough-cookie accepts);
  - SameSite=None without Secure is rejected (tough-cookie admits).
- whatwg-url (MIT): the WHATWG URL reference implementation.
  app/src/__tests__/url-oracle.test.ts asserts native URL parse and
  serialization parity on a parser-stress corpus, that mintableDest
  accepts exactly http/https, and that legacy routes round-trip every
  corpus URL byte-exactly.
- fake-indexeddb (above): doubles as the oracle for IndexedDB
  semantics where tests rely on it.

## Considered, deliberately not adopted (yet)

- adblock-rust (MPL-2.0, Brave): LobsterBrowse's server-side filter
  engine is its own Rust crate, wired and tested. Swapping it is an
  engine rewrite, not a dependency add. Candidate if filtering ever
  moves client-side into the SW.
- curl-impersonate (MIT): a fork of curl itself; not droppable into
  the reqwest/wisp stack. The integration point for TLS parity is the
  fingerprint-profile data (docs/fingerprint.md), nothing to run today.
- webextension-polyfill (MPL-2.0): unifies chrome.*/browser.* in real
  browsers. Zeolite builds both namespaces itself in the extension
  runtime (runtime buildApi), so the polyfill adds nothing here.

## Dependency health

npm audit on the runtime dependency set (tldts): 0 vulnerabilities.
Dev-tooling advisories exist (vitest/tinypool/esbuild chains) and are
dev-only, not shipped in any bundle.
