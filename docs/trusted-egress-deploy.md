# Trusted-egress wisp relay with authentication (#642)

This document describes how to deploy a Zeolite wisp relay on a trusted egress
host and point LobsterBrowse at it with authenticated access. It applies to any
wisp endpoint; the instructions are generic and do not assume a specific
provider.

## Architecture

Two components are involved:

1. zeolite-server, run on a host with trusted egress. It terminates the wisp
   protocol and forwards TCP streams to their destinations.
2. LobsterBrowse, which connects to that relay for proxied traffic.

The relay is reachable from any visitor's browser, so LobsterBrowse fronts the
connection with an app-level access password. When LB_ACCESS_PASSWORD is set,
the UI requires the password before the app is usable, and the server exposes a
/wispauth endpoint that exchanges the password for short-lived wisp credentials.

## Configuring zeolite-server

Run zeolite-server on the trusted host with a wisp user and password set:

    ZL_WISP_USER=relay ZL_WISP_PASSWORD=<long random secret> zeolite-server

Bind it to a trusted interface or put it behind TLS. Anyone who can reach the
wisp port can otherwise use the relay as an open proxy.

## Configuring LobsterBrowse

Set the following environment variables on the LobsterBrowse service:

    LB_ACCESS_PASSWORD=<the password visitors must enter>
    ZL_WISP_AUTH_URL=https://<zeolite-server>/wispauth
    ZL_WISP_USER=relay
    ZL_WISP_PASSWORD=<long random secret>

With these set, the UI shows the access-password gate, and once the visitor
passes it LobsterBrowse arms `zl:wispAuth`, obtains wisp credentials from the
/wispauth endpoint, and authenticates its wisp connection to the relay.

With the variables unset the gate is disabled and the relay connection is
unauthenticated, which is only appropriate for local or otherwise trusted
deployments.

## Honest limits

- The wisp credentials are delivered to the browser after the visitor passes
  the gate. Any visitor who passes the gate can read them; the password protects
  the gate, not the credentials from an authenticated visitor.
- The password comparison is constant-time with a delay, but the password is
  not run through a key-derivation function. Use a long random secret.
- The access cookie token is derived from the password, so it survives service
  restarts and deploys. Rotating the password invalidates existing sessions.
