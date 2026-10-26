# Experimental flags (host configuration)

Zeolite accepts the four experimental selections below through the
**existing host-only** `zl:config` request. They are **off by default**,
are stored in the current Service Worker lifetime. Only the optional
narrow **CSP deny-only** subset changes response headers today;
Adaptive NativeTransit runs shadow diagnostics without changing routing.

| Key | Issue | Current execution support |
| --- | --- | --- |
| `adaptiveTransit` | #487 | **Shadow-only** on live/cache paths; no routing changes |
| `hybridLocation` | #456 | **Not wired**; existing per-site KDL hybrid location policy remains separate |
| `cspTranslation` | #452 | **Deny-only subset** for HTML documents: object-src/base-uri/form-action 'none'; arbitrary policies remain stripped |
| `virtualSW` | #477 | **Not implemented**; registration groundwork is not guest execution |

## Protocol

```js
const message = {
  type: "zl:config",
  prefix: "/zl/",
  experimental: {
    adaptiveTransit: true,
    hybridLocation: false,
    cspTranslation: true,
    virtualSW: false,
  },
};
```

The acknowledgement (and `zl:ping`) includes:

```json
{
  "experimental": {
    "requested": {
      "adaptiveTransit": true,
      "hybridLocation": false,
      "cspTranslation": true,
      "virtualSW": false
    },
    "effective": {
      "adaptiveTransit": false,
      "hybridLocation": false,
      "cspTranslation": true,
      "virtualSW": false
    },
    "status": {
      "adaptiveTransit": "shadow-only",
      "hybridLocation": "not-wired",
      "cspTranslation": "deny-only",
      "virtualSW": "not-implemented"
    }
  }
}
```

`requested` is the operator's selected preference. **`effective`
is the authoritative execution state**, not an aspirational target.
The `cspTranslation` flag enables only validated deny-only upstream CSP
on HTML documents and disables CSP-less cache reuse for those documents.
Everything else remains off or non-enforcing: adaptive mode is shadow
telemetry, guest workers never execute, and hybrid rewriting is not wired.
A successful `zl:config` acknowledgment does not establish browser
compatibility or prove that any particular document had a candidate CSP.

Only the four named boolean properties are accepted. Unknown keys,
invalid values, arrays and non-plain objects are rejected atomically,
before applying the rest of the config. Proxied pages cannot set these
flags because `zl:config` remains host-only.

The host should resend its chosen values after worker restart.
LobsterBrowse Beta's existing five-click Home-wordmark Debug picker
persists operator selections locally and sends the same payload to
both app-origin and content-origin engine workers. Other hosts need
not expose any picker.

There are no new debug or logging flags and no MCP server in Zeolite.
