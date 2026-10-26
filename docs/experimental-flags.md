# Experimental flags (host configuration)

Zeolite accepts the four experimental selections below through the
**existing host-only** `zl:config` request. They are **off by default**,
are stored only in the current Service Worker lifetime, and do not
change request handling in this preliminary flag-registration stage.

| Key | Issue | Current execution support |
| --- | --- | --- |
| `adaptiveTransit` | #487 | **Not wired** to the existing conservative response planner |
| `hybridLocation` | #456 | **Not wired**; existing per-site KDL hybrid location policy remains separate |
| `cspTranslation` | #452 | **Not implemented** for live response enforcement; pure planner only |
| `virtualSW` | #477 | **Not implemented**; registration groundwork is not guest execution |

## Protocol

```js
const message = {
  type: "zl:config",
  prefix: "/zl/",
  experimental: {
    adaptiveTransit: true,
    hybridLocation: false,
    cspTranslation: false,
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
      "cspTranslation": false,
      "virtualSW": false
    },
    "effective": {
      "adaptiveTransit": false,
      "hybridLocation": false,
      "cspTranslation": false,
      "virtualSW": false
    },
    "status": {
      "adaptiveTransit": "not-wired",
      "hybridLocation": "not-wired",
      "cspTranslation": "not-implemented",
      "virtualSW": "not-implemented"
    }
  }
}
```

`requested` is the operator's selected preference. **`effective`
is the authoritative execution state**, not an aspirational target.
Until a feature's own security and Chromium gates are satisfied, these
choices never activate it. Never infer activation from `ok: true` on
`zl:config`; that means the request was accepted, not that an
experimental runtime is available.

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
