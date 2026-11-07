//! #614: RFC 6265 cookie parsing and jar bookkeeping in Rust.
//!
//! The specification layer for the engine cookie jar. The TS
//! module keeps the profile/namespace machinery, persistence and
//! the facade surfaces; this crate owns the pure semantics:
//! 5.1.1 date parsing, 5.2 Set-Cookie parsing into typed
//! attributes, 5.3 storage steps (identity, replacement,
//! deletion), 5.4 matching, and the 6.1 capacity limits with the
//! deterministic eviction policy. Attributes are typed structures
//! (an attribute cannot hide inside a name or value, the #599
//! class made unrepresentable instead of merely tested against).

pub mod date;
pub mod jar;
pub mod parse;
pub mod url;

pub use date::parse_cookie_date;
pub use jar::{
    Cookie, Jar, Reject, StoreOutcome, COOKIE_MAX_BYTES, COOKIE_MAX_PER_DOMAIN, COOKIE_MAX_TOTAL,
};
pub use parse::{parse_set_cookie, ParseReject, SameSite, SetCookie};
pub use url::{parse_http_url, Origin};
