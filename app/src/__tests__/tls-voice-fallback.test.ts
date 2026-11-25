/* TLS-voice fallback lane (2026-11-25): a UA-derived voice must keep
   proxied traffic alive when its shaped hello is refused at the TLS
   layer. The classifier is behavior-tested against the two live
   refusal shapes (a peer decode_error alert, seen from google.com
   frontends; a local certificate-extension parse failure, seen from
   example.com), and the source contract pins the retry seam in the
   vendored transport so the fallback cannot silently rot. Explicit
   voice pins keep their honest failure; only the derived voice falls
   back, once, worker-wide. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  epoxyIdentityForUa,
  epoxyIdentityVoiceOf,
  epoxyTlsRefusalError,
  epoxyVoiceFallbackActive,
} from "../libcurl-transport-vendored";

describe("epoxyTlsRefusalError (TLS-refusal classifier)", () => {
  it("recognizes the live peer-alert shape", () => {
    expect(
      epoxyTlsRefusalError(
        new Error(
          "Hyper client: hyper_util::client::legacy::Error(Connect, Io(Custom { kind: InvalidData, error: AlertReceived(DecodeError) }))",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes local handshake parse failures", () => {
    expect(epoxyTlsRefusalError(new Error("Hyper client: InvalidMessage(UnknownCertificateExtension)"))).toBe(true);
    expect(epoxyTlsRefusalError(new Error("PeerMisbehaved: bad handshake message"))).toBe(true);
  });

  it("leaves connect-class and transport errors alone", () => {
    expect(epoxyTlsRefusalError(new Error("websocket did not open"))).toBe(false);
    expect(epoxyTlsRefusalError(new Error("failed sending data"))).toBe(false);
    expect(epoxyTlsRefusalError(new Error("zeolite: transport not initialized (call init first)"))).toBe(false);
  });

  it("only classifies Error objects", () => {
    expect(epoxyTlsRefusalError("AlertReceived(DecodeError)")).toBe(false);
    expect(epoxyTlsRefusalError(null)).toBe(false);
    expect(epoxyTlsRefusalError(undefined)).toBe(false);
  });
});

describe("voice mapping stays honest", () => {
  it("UA-synced derivation and explicit pins keep their identities", () => {
    expect(epoxyIdentityForUa("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36")).toBe(1);
    expect(epoxyIdentityForUa("Mozilla/5.0 (Windows NT 10.0) Firefox/160.0")).toBe(2);
    expect(epoxyIdentityForUa("curl/8.0")).toBe(0);
    expect(epoxyIdentityVoiceOf("chromium")).toBe(1);
    expect(epoxyIdentityVoiceOf("firefox")).toBe(2);
    expect(epoxyIdentityVoiceOf("native")).toBe(0);
    expect(epoxyIdentityVoiceOf("ua")).toBe(null);
  });

  it("the fallback starts disarmed", () => {
    expect(epoxyVoiceFallbackActive()).toBe(false);
  });
});

describe("source contract: the auto-fallback seam stays pinned", () => {
  const src = readFileSync(new URL("../libcurl-transport-vendored.ts", import.meta.url), "utf8");

  it("the retry only fires for a derived voice, once per worker", () => {
    expect(src.includes("epoxyIdentityVoice !== null || epoxyVoiceFallbackArmed || !epoxyTlsRefusalError(err)")).toBe(true);
    expect(src.split("epoxyVoiceFallbackArmed = true").length - 1).toBe(1);
  });

  it("the armed flag rebuilds the client on the native hello", () => {
    expect(src.includes("options.identity = epoxyVoiceFallbackArmed")).toBe(true);
    expect(src.includes("TLS voice refused; auto-fallback to native")).toBe(true);
  });

  it("both voice setters re-arm the fallback on a real change", () => {
    expect(src.split("\n  epoxyVoiceFallbackArmed = false;").length - 1).toBe(2);
  });
});
