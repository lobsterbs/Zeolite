__FINGERPRINT__

## Transport engine binding

Since the selectable second engine (#64), the TLS handshake
fingerprint is a property of the transport engine, not a profile
field: libcurl terminates TLS through libcurl.js (mbedTLS), epoxy
through rustls + hyper. A FingerprintProfile never rewrites the TLS
handshake (JA3/JA4, ALPN, HTTP/2 SETTINGS); no profile field can, by
design, because the engine is the only component that terminates
TLS. What does flow from the profile on both engines, per request
and identically: the profile `User-Agent` and the `languages`-
derived `Accept-Language`. Switching engines (the `zl:transport`
control message, or the deployment `ZL_TRANSPORT` define) changes
the handshake fingerprint; that is the whole point of offering two
stacks, and it is the only way to change it.
