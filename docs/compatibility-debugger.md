# Request-scoped compatibility debugger — #494, first safe slice

Zeolite now exposes a **read-only, host-only** `zl:exportDiagnostics`
request. This is a **request-scoped** evidence exporter, **not** a claim
that the complete #494 document/navigation debugger has shipped.

The service worker will only answer if all of these observations agree:

1. The caller is one of Zeolite's existing, verified **host pages**.
2. The host supplies a bounded `clientId` and engine-generated `traceId`.
3. The worker's own `traceClient(traceId)` attribution matches that client.
4. `self.clients.get(clientId)` still returns a live, same-origin **proxied
   route client**. Stale, navigated-away, foreign or host-page identities
   are refused. Missing identity never falls back to the global ring.

## Host API

For a selected network request whose `traceId` and `clientId` are
present in a previously received host-authorized `zl:getNetLog` row:

```js
const ch = new MessageChannel();
ch.port1.onmessage = ({ data }) => {
  if (!data.ok) {
    // "identity-unavailable": missing, stale or unverified attribution.
    return;
  }
  // data.scope === "request"; data.collection is
  // "observed" or "no-evidence", NOT a page success indicator.
  // data.steps: bounded observed facts; data.kdl: same report.
  console.log(data.steps, data.kdl);
};
navigator.serviceWorker.controller?.postMessage({
  type: "zl:exportDiagnostics", clientId, traceId
}, [ch.port2]);
```

This V1 report does not accept arbitrary target URLs, untrusted
document origins, arbitrary time windows, or an unscoped `all` mode.

## KDL schema v1

```kdl
zeolite-debug version=1 scope="request" redaction="strict" collection="observed" trace="zl-tabc123-1" generation=123 captured-at=456 {
  step source="diagnostic" code="REQUEST_INTERCEPTED" at=100 severity="info" cause="unknown"
  step source="network" code="RESPONSE_OBSERVATION" at=110 status=502 decision="RewriteFallback" reason="POLICY_REWRITE"
}
```

**All user-controlled string fields are omitted**, not merely matched
against a blacklist. The engine serializes only fixed allowlisted event
stages, severity, cause, transport/rewriter decision, documented fallback
reasons, and bounded status/timestamp integers. Raw destination URLs,
query strings, usernames, headers, cookie/authorization values,
request/response bodies, error strings, KDL rule names/values and
untrusted trace results do not appear. This also applies when the
in-memory diagnostic ring already contains hostile unsanitized strings.
The report includes a synthetic ordering of the observed events by
recorded timestamp, but it does not infer causation or unseen steps.

`collection="no-evidence"` means no matching rows remain in the bounded
memory rings; it **does not** mean success, no errors, or a loaded page.
Traces are lost when the ring evicts them or the Service Worker restarts.

## Standalone UI

Open Zeolite's standalone `/devtools.html`; select a network request.
The **Export selected request KDL** button is enabled only if that row
includes a `traceId` and `clientId`. Clicking it asks the worker to
verify the live client/trace again, then downloads a local
`zeolite-request.kdl`. Expired identity shows an unavailable status;
there is no global fallback and no automatic upload.

Other hosts may use the same generic control-plane API. **Zeolite
does not ship an MCP server.** LobsterBrowse Beta already has one and
may choose whether to expose the host's authorized KDL snapshots
through it (LobsterBrowse#224).

## Remaining work before closing #494

- Document-lifetime identity/generation matching, including navigating
  within a browser client while keeping it alive. The current exporter
  intentionally limits itself to one independently verified trace.
- A full cross-request, cross-frame, decision-by-decision timeline with
  verified transport delivery/retry provenance, policy rule explanations
  and a declared `not-observed` status for every missing stage.
- Browser fixture showing the real UI and KDL agree for complex redirects,
  worker restarts, error pages, CAPTCHA stages and unavailable identity.
- A versioned common KDL envelope unifying Doctor, debugger, tracing
  and any future user-authorized session export.
- Host-specific optional MCP exposure is owned by the host maintainer,
  never by Zeolite's Service Worker.
