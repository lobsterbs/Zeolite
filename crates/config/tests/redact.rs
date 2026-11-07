//! #616 redaction oracle: exact-output rows from the diag.ts
//! redactSecrets behavior (diag.test.ts asserts containment;
//! these rows pin the exact TS outputs, computed against the TS
//! regex chain) plus hostile-input rows: the passes are linear
//! single-pass scanners, so hostile shapes complete instead of
//! backtracking - linear completion IS the guarantee, no timing
//! asserts.

use zeolite_config::redact_secrets;

#[test]
fn redacts_url_userinfo_and_query_secrets() {
    let dest = "https://u:password-secret@a.test/?code=code-secret&cf-turnstile-response=captcha-secret&view=mail";
    assert_eq!(
        redact_secrets(dest),
        "https://[redacted]@a.test/?code=[redacted]&cf-turnstile-response=[redacted]&view=mail"
    );
}

#[test]
fn redacts_stack_traces_like_the_diag_ring() {
    let stack = "Error: https://name:password@site.example/path?access_token=abc; Bearer abc+def/ghi==; Basic abcd+efg==";
    assert_eq!(
        redact_secrets(stack),
        "Error: https://[redacted]@site.example/path?access_token=[redacted] Bearer [redacted]; Basic [redacted]"
    );
}

#[test]
fn redacts_bearer_and_keyword_credentials_in_messages() {
    let note = "POST token=LEAK5 authorization: Bearer LEAK6";
    assert_eq!(
        redact_secrets(note),
        "POST token=[redacted] authorization: [redacted]"
    );
}

#[test]
fn non_secret_query_params_survive() {
    let captcha = "https://captcha.example/?c=LEAK7&reason=q&sitekey=LEAK4";
    assert_eq!(redact_secrets(captcha), captcha);
}

#[test]
fn empty_query_secret_still_redacts() {
    assert_eq!(redact_secrets("?code=&x=1"), "?code=[redacted]&x=1");
}

#[test]
fn userinfo_match_starts_at_the_first_scheme_letter() {
    assert_eq!(
        redact_secrets("1http://user@host"),
        "1http://[redacted]@host"
    );
}

#[test]
fn case_insensitive_across_all_passes() {
    assert_eq!(
        redact_secrets("AUTHORIZATION: BEARER Secret1"),
        "AUTHORIZATION: [redacted]"
    );
    assert_eq!(
        redact_secrets("Cookie: SESSION=abc; path=/"),
        "Cookie: [redacted]; path=/"
    );
    assert_eq!(redact_secrets("X-API-KEY: value1"), "X-API-KEY: [redacted]");
}

#[test]
fn unicode_whitespace_terminates_values_like_js_s() {
    // U+00A0 is ECMAScript \s: the value stops there in TS, so
    // it stops here too and the rest of the query survives.
    let src = "?code=abc\u{a0}def&x=1";
    assert_eq!(redact_secrets(src), "?code=[redacted]\u{a0}def&x=1");
}

#[test]
fn idempotent_on_already_redacted_text() {
    let once = redact_secrets("POST token=LEAK5 authorization: Bearer LEAK6");
    assert_eq!(redact_secrets(&once), once);
}

#[test]
fn hostile_inputs_complete_linearly() {
    let big = "a".repeat(1024 * 1024);
    assert_eq!(redact_secrets(&big), big);

    let tokens = "token=x ".repeat(100_000);
    let out = redact_secrets(&tokens);
    assert!(out.contains("[redacted]"));
    assert!(!out.contains("token=x"));

    let codes = "?code=x ".repeat(100_000);
    let out = redact_secrets(&codes);
    assert!(!out.contains("code=x"));

    let bearers = "Bearer x ".repeat(100_000);
    let out = redact_secrets(&bearers);
    assert!(!out.contains("Bearer x"));

    let userinfo = format!("http://{}@x", "a".repeat(512 * 1024));
    assert_eq!(redact_secrets(&userinfo), "http://[redacted]@x");
}
