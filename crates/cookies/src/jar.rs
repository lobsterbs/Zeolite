//! RFC 6265 5.3-5.4 jar storage, matching and 6.1 limits.
//!
//! Flat-profile port of the TS jar (cookies.ts): one Vec-backed
//! jar, identity keyed on name+domain+host_only+path, deletion
//! honored through the same storage steps as writes, and the
//! deterministic 6.1 eviction (expired first, then per-domain
//! excess, then total excess, both by expiry then creation).
//! The public-suffix gate is injected as a closure: the tldts
//! dataset stays at the TS seam and the crate stays dep-free.
//! The SameSite gate on attach stays TS-side too (it is a
//! policy knob, not storage semantics).

use crate::parse::{parse_set_cookie, SameSite, SetCookie};
use crate::url::Origin;

/// 6.1: at least 4096 bytes per cookie, 50 per domain, 3000 total.
pub const COOKIE_MAX_BYTES: usize = 4096;
pub const COOKIE_MAX_PER_DOMAIN: usize = 50;
pub const COOKIE_MAX_TOTAL: usize = 3000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
    /// Epoch millis. 0 means a session cookie.
    pub expires: i64,
    /// Epoch millis, kept across replacement of the same identity.
    pub created: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reject {
    Malformed,
    ControlCharacter,
    /// 5.3 step: SameSite=None needs Secure (5.4 beta).
    SameSiteNoneWithoutSecure,
    /// 5.3 step: Secure cookies need a secure origin, with the
    /// loopback exception (the TS engine grants it).
    SecureFromInsecureOrigin,
    Domain,
    PrefixRequiresSecure,
    HostPrefixRequiresRoot,
    Size,
    /// A script write targeting an HttpOnly identity.
    HttpOnlyScriptWrite,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreOutcome {
    Stored {
        cookie: Cookie,
        replaced: bool,
        evicted: Vec<Cookie>,
    },
    Deleted {
        cookie: Option<Cookie>,
    },
    Noop,
    Rejected(Reject),
}

fn looks_like_ip(host: &str) -> bool {
    host.bytes().filter(|b| *b == b'.').count() == 3
        && !host.is_empty()
        && host
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 5.1.3: exact host match, or a domain-suffix match on a host
/// that is not an IP literal.
fn domain_match(host: &str, domain: &str) -> bool {
    host == domain || (host.ends_with(&format!(".{}", domain)) && !looks_like_ip(host))
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.split('.').next().is_some_and(|first| first == "127")
        || host == "[::1]"
}

fn is_secure_origin(origin: &Origin) -> bool {
    origin.secure || is_loopback_host(&origin.host)
}

/// 5.1.4: default the path to the directory of the request URI.
fn default_path(req_path: &str) -> String {
    if !req_path.starts_with('/') {
        return "/".to_string();
    }
    let idx = req_path.rfind('/').unwrap_or(0);
    if idx == 0 {
        return "/".to_string();
    }
    req_path[..idx].to_string()
}

/// 5.1.4 path-match.
fn path_match(req_path: &str, cookie_path: &str) -> bool {
    cookie_path == "/"
        || req_path == cookie_path
        || (req_path.starts_with(cookie_path)
            && (cookie_path.ends_with('/')
                || req_path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

/// Identity: a replacement preserves this key's creation time.
fn same_identity(a: &Cookie, b: &Cookie) -> bool {
    a.name == b.name && a.domain == b.domain && a.host_only == b.host_only && a.path == b.path
}

/// Eviction priority: sooner expiry first, then earlier created.
fn order_key(c: &Cookie) -> (i64, i64) {
    (if c.expires == 0 { i64::MAX } else { c.expires }, c.created)
}

#[derive(Default, Debug)]
pub struct Jar {
    cookies: Vec<Cookie>,
}

impl Jar {
    pub fn new() -> Jar {
        Jar {
            cookies: Vec::new(),
        }
    }

    pub fn cookies(&self) -> &[Cookie] {
        &self.cookies
    }

    /// 5.3 storage steps over a raw Set-Cookie header. `now` is
    /// injected (epoch millis) so tests are deterministic; the
    /// wasm boundary passes Date.now(). `is_public_suffix` gates
    /// Domain attributes (PSL stays at the caller).
    pub fn store<P>(
        &mut self,
        origin: &Origin,
        header: &str,
        from_script: bool,
        now: i64,
        is_public_suffix: P,
    ) -> StoreOutcome
    where
        P: Fn(&str) -> bool,
    {
        match parse_set_cookie(header) {
            Ok(sc) => self.store_parsed(origin, &sc, from_script, now, is_public_suffix),
            Err(crate::parse::ParseReject::ControlCharacter) => {
                StoreOutcome::Rejected(Reject::ControlCharacter)
            }
            Err(crate::parse::ParseReject::Malformed) => StoreOutcome::Rejected(Reject::Malformed),
        }
    }

    /// 5.3 storage steps over already-typed parts (#599 facade
    /// boundary: cookieStore.set-shaped calls skip the header
    /// parser).
    pub fn store_parsed<P>(
        &mut self,
        origin: &Origin,
        sc: &SetCookie,
        from_script: bool,
        now: i64,
        is_public_suffix: P,
    ) -> StoreOutcome
    where
        P: Fn(&str) -> bool,
    {
        let host = origin.host.as_str();
        if sc.same_site == Some(SameSite::None) && !sc.secure {
            return StoreOutcome::Rejected(Reject::SameSiteNoneWithoutSecure);
        }
        if sc.secure && !is_secure_origin(origin) {
            return StoreOutcome::Rejected(Reject::SecureFromInsecureOrigin);
        }
        let (domain, host_only) = match &sc.domain {
            Some(d) => (d.clone(), false),
            None => (host.to_string(), true),
        };
        let path = sc
            .path
            .clone()
            .unwrap_or_else(|| default_path(&origin.path));
        if !host_only
            && (is_public_suffix(&domain)
                || !domain_match(host, &domain)
                || (!domain.contains('.') && domain != host))
        {
            return StoreOutcome::Rejected(Reject::Domain);
        }
        if (sc.name.starts_with("__Secure-") || sc.name.starts_with("__Host-")) && !sc.secure {
            return StoreOutcome::Rejected(Reject::PrefixRequiresSecure);
        }
        if sc.name.starts_with("__Host-") && (!host_only || path != "/") {
            return StoreOutcome::Rejected(Reject::HostPrefixRequiresRoot);
        }
        let is_deletion = match sc.max_age {
            Some(m) => m <= 0,
            None => sc.expires.is_some_and(|t| t <= now),
        };
        let expiry = sc
            .max_age
            .map(|m| now + m * 1000)
            .unwrap_or(sc.expires.unwrap_or(0));
        /* 6.1 size gate: UTF-8 bytes of name+value. Deletions
        are never size-gated, so an oversized cookie can still
        be cleaned up. */
        if !is_deletion && sc.name.len() + sc.value.len() > COOKIE_MAX_BYTES {
            return StoreOutcome::Rejected(Reject::Size);
        }
        let fresh = Cookie {
            name: sc.name.clone(),
            value: sc.value.clone(),
            domain: domain.clone(),
            host_only,
            path,
            secure: sc.secure,
            http_only: sc.http_only,
            same_site: sc.same_site,
            expires: expiry,
            created: now,
        };
        if is_deletion {
            let mut removed: Option<Cookie> = None;
            let before = self.cookies.len();
            self.cookies.retain(|c| {
                if same_identity(c, &fresh) && !(from_script && c.http_only) {
                    if removed.as_ref().is_none_or(|r| c.created < r.created) {
                        removed = Some(c.clone());
                    }
                    return false;
                }
                true
            });
            if self.cookies.len() == before {
                return StoreOutcome::Noop;
            }
            return StoreOutcome::Deleted { cookie: removed };
        }
        /* Replacement: the earliest-created same-identity cookie
        wins, its created time is preserved, and every other
        same-identity duplicate collapses into its slot. */
        let mut target: Option<usize> = None;
        for (i, c) in self.cookies.iter().enumerate() {
            if same_identity(c, &fresh) {
                if from_script && c.http_only {
                    return StoreOutcome::Rejected(Reject::HttpOnlyScriptWrite);
                }
                if target.is_none() || c.created < self.cookies[target.unwrap()].created {
                    target = Some(i);
                }
            }
        }
        let mut replaced = false;
        match target {
            Some(t) => {
                replaced = true;
                let mut fresh2 = fresh.clone();
                fresh2.created = self.cookies[t].created;
                /* Collapse duplicates: keep the target index,
                drop every other same-identity cookie. */
                let mut kept: Vec<Cookie> = Vec::with_capacity(self.cookies.len());
                for (i, c) in std::mem::take(&mut self.cookies).into_iter().enumerate() {
                    if i == t {
                        kept.push(fresh2.clone());
                    } else if !same_identity(&c, &fresh) {
                        kept.push(c);
                    }
                }
                self.cookies = kept;
            }
            None => self.cookies.push(fresh.clone()),
        }
        let evicted = self.sweep_limits(Some(&fresh), now);
        StoreOutcome::Stored {
            cookie: fresh,
            replaced,
            evicted,
        }
    }

    /// 6.1 capacity limits. The just-stored cookie is protected
    /// from its own admission eviction. Pass 1 drops the
    /// expired; pass 2 trims per-domain excess; pass 3 trims the
    /// total. Excess is counted over ALL cookies of the domain
    /// but evicted only from unprotected candidates, in order_key
    /// order (soonest expiry first, session last, ties by
    /// creation).
    pub fn sweep_limits(&mut self, protect: Option<&Cookie>, now: i64) -> Vec<Cookie> {
        let mut removed: Vec<Cookie> = Vec::new();
        let mut live: Vec<Cookie> = Vec::new();
        for c in std::mem::take(&mut self.cookies) {
            if c.expires != 0 && c.expires <= now {
                removed.push(c);
            } else {
                live.push(c);
            }
        }
        let protected = |c: &Cookie| protect.is_some_and(|p| same_identity(p, c));
        let mut domains: Vec<String> = Vec::new();
        for c in &live {
            if !domains.iter().any(|d| d == &c.domain) {
                domains.push(c.domain.clone());
            }
        }
        for d in domains {
            let count = live.iter().filter(|c| c.domain == d).count();
            if count <= COOKIE_MAX_PER_DOMAIN {
                continue;
            }
            let excess = count - COOKIE_MAX_PER_DOMAIN;
            let mut cands: Vec<usize> = live
                .iter()
                .enumerate()
                .filter(|(_, c)| c.domain == d && !protected(c))
                .map(|(i, _)| i)
                .collect();
            cands.sort_by_key(|&i| order_key(&live[i]));
            let mut doomed: Vec<usize> = cands.into_iter().take(excess).collect();
            doomed.sort_unstable_by(|a, b| b.cmp(a));
            for i in doomed {
                removed.push(live.remove(i));
            }
        }
        if live.len() > COOKIE_MAX_TOTAL {
            let excess = live.len() - COOKIE_MAX_TOTAL;
            let mut cands: Vec<usize> = live
                .iter()
                .enumerate()
                .filter(|(_, c)| !protected(c))
                .map(|(i, _)| i)
                .collect();
            cands.sort_by_key(|&i| order_key(&live[i]));
            let mut doomed: Vec<usize> = cands.into_iter().take(excess).collect();
            doomed.sort_unstable_by(|a, b| b.cmp(a));
            for i in doomed {
                removed.push(live.remove(i));
            }
        }
        self.cookies = live;
        removed
    }

    /// 5.4 matching + 5.4 attachment order (longer paths first,
    /// then earlier created first) serialized as a Cookie header,
    /// or None when nothing matches. The Secure gate has no
    /// loopback exception here (pinned #191 deviation).
    pub fn header_for(&mut self, request: &Origin, now: i64) -> Option<String> {
        self.cookies.retain(|c| c.expires == 0 || c.expires > now);
        let mut matched: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|c| {
                (if c.host_only {
                    c.domain == request.host
                } else {
                    domain_match(&request.host, &c.domain)
                }) && (!c.secure || request.secure)
                    && path_match(&request.path, &c.path)
            })
            .collect();
        matched.sort_by(|a, b| {
            b.path
                .len()
                .cmp(&a.path.len())
                .then(a.created.cmp(&b.created))
        });
        if matched.is_empty() {
            return None;
        }
        Some(
            matched
                .iter()
                .map(|c| format!("{}={}", c.name, c.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    /// document.cookie oracle: match without mutating, skipping
    /// HttpOnly and expired cookies.
    pub fn match_document(&self, page: &Origin, now: i64) -> Vec<&Cookie> {
        let mut matched: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|c| {
                !c.http_only
                    && (c.expires == 0 || c.expires > now)
                    && (if c.host_only {
                        c.domain == page.host
                    } else {
                        domain_match(&page.host, &c.domain)
                    })
                    && (!c.secure || page.secure)
                    && path_match(&page.path, &c.path)
            })
            .collect();
        matched.sort_by(|a, b| {
            b.path
                .len()
                .cmp(&a.path.len())
                .then(a.created.cmp(&b.created))
        });
        matched
    }
}
