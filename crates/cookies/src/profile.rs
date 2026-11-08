//! The bucketed jar profile: the stateful storage layer the wasm
//! registry drives, a faithful port of the TS engine's jar map
//! (cookies.ts). One Profile is one cookie namespace; buckets are
//! keyed by the bare virtual-origin id. Identity, replacement,
//! deletion and the per-domain capacity counts CROSS buckets
//! exactly like the TS seams: a Domain cookie admitted by one
//! origin must be deletable, replaceable and countable wherever a
//! sibling origin stored it (#337, #598). The flat Jar in jar.rs
//! stays the specification layer for the pure semantics.
//!
//! The storage steps here do NOT sweep: the TS admission seam runs
//! the capacity sweep AFTER the store with the fresh identity
//! protected, and the persist seam runs it without protection.
//! sweep() carries that contract.
//!
//! Honest divergence: buckets iterate in BTreeMap order while the
//! TS Map is insertion-ordered; the only observable difference is
//! the loser of a capacity tie between same-domain candidates
//! with identical expiry AND creation times in different buckets.

use crate::jar::{
    build_cookie, domain_match, order_key, path_match, same_identity, Cookie, Reject, StoreOutcome,
    COOKIE_MAX_PER_DOMAIN, COOKIE_MAX_TOTAL,
};
use crate::parse::{parse_set_cookie, SetCookie};
use crate::url::Origin;
use std::collections::BTreeMap;

/// The merge-conflict rule (zl:importSession merge mode).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeRule {
    ImportWins,
    KeepNewest,
    /// Count the conflict but keep the existing cookie (the TS
    /// jarMerge "keep-existing" rule).
    KeepExisting,
}

/// A cookie identity to remove (the browser.cookies.remove seam).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CookieIdentity {
    pub name: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
}

#[derive(Default, Debug)]
pub struct Profile {
    buckets: BTreeMap<String, Vec<Cookie>>,
}

impl Profile {
    pub fn new() -> Profile {
        Profile::default()
    }

    fn keys(&self) -> Vec<String> {
        self.buckets.keys().cloned().collect()
    }

    fn drop_empty(&mut self) {
        self.buckets.retain(|_, v| !v.is_empty());
    }

    /// Buckets with their cookies (export order: key ascending).
    pub fn buckets(&self) -> impl Iterator<Item = (&String, &Vec<Cookie>)> {
        self.buckets.iter()
    }

    /// 5.2 + 5.3 over a raw Set-Cookie header, stored into the
    /// response origin's bucket.
    pub fn store<P>(
        &mut self,
        bucket: &str,
        origin: &Origin,
        header: &str,
        from_script: bool,
        now: i64,
        psl: P,
    ) -> StoreOutcome
    where
        P: Fn(&str) -> bool,
    {
        match parse_set_cookie(header) {
            Ok(sc) => self.store_parsed(bucket, origin, &sc, from_script, now, psl),
            Err(crate::parse::ParseReject::ControlCharacter) => {
                StoreOutcome::Rejected(Reject::ControlCharacter)
            }
            Err(crate::parse::ParseReject::Malformed) => StoreOutcome::Rejected(Reject::Malformed),
        }
    }

    /// 5.3 storage steps with cross-bucket identity semantics: a
    /// deletion retires every copy of the identity in the profile,
    /// a replacement keeps the earliest-created copy's bucket and
    /// creation time and collapses sibling-bucket duplicates, and
    /// only a genuinely new identity lands in this bucket. No
    /// admission sweep runs here (the caller sweeps with the
    /// fresh identity protected).
    pub fn store_parsed<P>(
        &mut self,
        bucket: &str,
        origin: &Origin,
        sc: &SetCookie,
        from_script: bool,
        now: i64,
        psl: P,
    ) -> StoreOutcome
    where
        P: Fn(&str) -> bool,
    {
        let (fresh, is_deletion) = match build_cookie(origin, sc, now, &psl) {
            Ok(x) => x,
            Err(r) => return StoreOutcome::Rejected(r),
        };
        let same = |c: &Cookie| same_identity(c, &fresh);
        if is_deletion {
            let mut removed_cookie: Option<Cookie> = None;
            let mut removed_any = false;
            for key in self.keys() {
                let list = self.buckets.get_mut(&key).unwrap();
                list.retain(|c| {
                    if same(c) && !(from_script && c.http_only) {
                        if removed_cookie
                            .as_ref()
                            .is_none_or(|r| c.created < r.created)
                        {
                            removed_cookie = Some(c.clone());
                        }
                        removed_any = true;
                        return false;
                    }
                    true
                });
            }
            self.drop_empty();
            if !removed_any {
                return StoreOutcome::Noop;
            }
            return StoreOutcome::Deleted {
                cookie: removed_cookie,
            };
        }
        let mut target: Option<(String, usize)> = None;
        let mut existing_created: Option<i64> = None;
        let mut existing_http_only = false;
        for (key, list) in &self.buckets {
            for (i, c) in list.iter().enumerate() {
                if !same(c) {
                    continue;
                }
                if existing_created.is_none_or(|t| c.created < t) {
                    target = Some((key.clone(), i));
                    existing_created = Some(c.created);
                    existing_http_only = c.http_only;
                }
            }
        }
        if from_script && existing_created.is_some() && existing_http_only {
            return StoreOutcome::Rejected(Reject::HttpOnlyScriptWrite);
        }
        let replaced = target.is_some();
        let mut stored = fresh.clone();
        match target {
            Some((tkey, tidx)) => {
                stored.created = existing_created.unwrap();
                for key in self.keys() {
                    if key == tkey {
                        continue;
                    }
                    if let Some(list) = self.buckets.get_mut(&key) {
                        list.retain(|c| !same(c));
                    }
                }
                self.buckets.get_mut(&tkey).unwrap()[tidx] = stored.clone();
            }
            None => {
                self.buckets
                    .entry(bucket.to_string())
                    .or_default()
                    .push(stored.clone());
            }
        }
        self.drop_empty();
        StoreOutcome::Stored {
            cookie: stored,
            replaced,
            evicted: Vec::new(),
        }
    }

    /// RFC 6265 6.1 capacity sweep over the whole profile, the TS
    /// algorithm: expired cookies first, then per-domain excess,
    /// then total excess, candidates sorted by (expiry, created)
    /// with session cookies last; protect shields one identity
    /// from its own admission pass. Domain counts span buckets.
    pub fn sweep(&mut self, protect: Option<&Cookie>, now: i64) -> Vec<Cookie> {
        let protected = |c: &Cookie| protect.is_some_and(|p| same_identity(p, c));
        let live = |c: &Cookie| c.expires == 0 || c.expires > now;
        let mut removed: Vec<Cookie> = Vec::new();
        for key in self.keys() {
            let list = self.buckets.get_mut(&key).unwrap();
            list.retain(|c| {
                if live(c) {
                    true
                } else {
                    removed.push(c.clone());
                    false
                }
            });
        }
        self.drop_empty();
        let collect = |p: &Profile| -> BTreeMap<String, Vec<(String, Cookie)>> {
            let mut by: BTreeMap<String, Vec<(String, Cookie)>> = BTreeMap::new();
            for (key, list) in &p.buckets {
                for c in list {
                    if !live(c) {
                        continue;
                    }
                    by.entry(c.domain.clone())
                        .or_default()
                        .push((key.clone(), c.clone()));
                }
            }
            by
        };
        let mut doomed: Vec<(String, Cookie)> = Vec::new();
        for entries in collect(self).values() {
            if entries.len() > COOKIE_MAX_PER_DOMAIN {
                let excess = entries.len() - COOKIE_MAX_PER_DOMAIN;
                let mut cands: Vec<&(String, Cookie)> =
                    entries.iter().filter(|e| !protected(&e.1)).collect();
                cands.sort_by_key(|e| order_key(&e.1));
                for e in cands.into_iter().take(excess) {
                    removed.push(e.1.clone());
                    doomed.push((e.0.clone(), e.1.clone()));
                }
            }
        }
        let all: Vec<(String, Cookie)> = collect(self).into_values().flatten().collect();
        if all.len() > COOKIE_MAX_TOTAL {
            let excess = all.len() - COOKIE_MAX_TOTAL;
            let mut cands: Vec<&(String, Cookie)> =
                all.iter().filter(|e| !protected(&e.1)).collect();
            cands.sort_by_key(|e| order_key(&e.1));
            for e in cands.into_iter().take(excess) {
                removed.push(e.1.clone());
                doomed.push((e.0.clone(), e.1.clone()));
            }
        }
        /* Remove exactly one copy per doomed entry: two
        field-identical copies are indistinguishable, but the
        counts must still match the TS object-identity removal. */
        for (k, d) in &doomed {
            if let Some(list) = self.buckets.get_mut(k) {
                if let Some(i) = list.iter().position(|c| c == d) {
                    list.remove(i);
                }
            }
        }
        self.drop_empty();
        removed
    }

    /// 5.4 request matching across the profile: expired cookies are
    /// purged lazily (the purged list tells the caller to
    /// reschedule persistence), each cookie matches on its own
    /// domain/host-only/path/secure scope, and the 5.4 order is
    /// longer paths first, then earlier created.
    pub fn match_request(&mut self, request: &Origin, now: i64) -> (Vec<Cookie>, Vec<Cookie>) {
        let mut purged: Vec<Cookie> = Vec::new();
        for key in self.keys() {
            let list = self.buckets.get_mut(&key).unwrap();
            list.retain(|c| {
                if c.expires == 0 || c.expires > now {
                    true
                } else {
                    purged.push(c.clone());
                    false
                }
            });
        }
        self.drop_empty();
        (self.match_live(request, now, false), purged)
    }

    /// document.cookie oracle (5.4 document scope): no HttpOnly,
    /// no expired, no mutation.
    pub fn match_document(&self, page: &Origin, now: i64) -> Vec<Cookie> {
        self.match_live(page, now, true)
    }

    fn match_live(&self, page: &Origin, now: i64, document: bool) -> Vec<Cookie> {
        let mut matched: Vec<Cookie> = Vec::new();
        for list in self.buckets.values() {
            for c in list {
                if document && c.http_only {
                    continue;
                }
                if c.expires != 0 && c.expires <= now {
                    continue;
                }
                let domain_ok = if c.host_only {
                    c.domain == page.host
                } else {
                    domain_match(&page.host, &c.domain)
                };
                if domain_ok && (!c.secure || page.secure) && path_match(&page.path, &c.path) {
                    matched.push(c.clone());
                }
            }
        }
        matched.sort_by(|a, b| {
            b.path
                .len()
                .cmp(&a.path.len())
                .then(a.created.cmp(&b.created))
        });
        matched
    }

    /// Retire identities wherever they live in the profile; returns
    /// how many cookies were removed.
    pub fn remove_identities(&mut self, ids: &[CookieIdentity]) -> usize {
        let mut removed = 0usize;
        for key in self.keys() {
            let list = self.buckets.get_mut(&key).unwrap();
            list.retain(|c| {
                if ids.iter().any(|i| {
                    i.name == c.name
                        && i.domain == c.domain
                        && i.host_only == c.host_only
                        && i.path == c.path
                }) {
                    removed += 1;
                    return false;
                }
                true
            });
        }
        self.drop_empty();
        removed
    }

    /// Import one bucket (persistence restore, session import). An
    /// empty list drops the bucket, like the TS seams that never
    /// store empty jars.
    pub fn set_bucket(&mut self, id: &str, cookies: Vec<Cookie>) {
        if cookies.is_empty() {
            self.buckets.remove(id);
        } else {
            self.buckets.insert(id.to_string(), cookies);
        }
    }

    /// Clear one origin bucket; returns how many cookies died.
    pub fn clear_bucket(&mut self, id: &str) -> usize {
        match self.buckets.remove(id) {
            Some(v) => v.len(),
            None => 0,
        }
    }

    /// Clear the whole profile; returns (jars, cookies) counts.
    pub fn clear(&mut self) -> (usize, usize) {
        let jars = self.buckets.len();
        let cookies: usize = self.buckets.values().map(|v| v.len()).sum();
        self.buckets.clear();
        (jars, cookies)
    }

    /// Session-import merge: bucket-local identity conflicts resolve
    /// by the rule; returns (jars touched, cookies added,
    /// conflicts seen).
    pub fn merge(
        &mut self,
        entries: &[(String, Vec<Cookie>)],
        rule: MergeRule,
    ) -> (usize, usize, usize) {
        let mut jars = 0usize;
        let mut cookies = 0usize;
        let mut conflicts = 0usize;
        for (key, list) in entries {
            if list.is_empty() {
                continue;
            }
            let jar = self.buckets.entry(key.clone()).or_default();
            let mut touched = false;
            for c in list {
                match jar.iter().position(|x| same_identity(x, c)) {
                    Some(idx) => {
                        conflicts += 1;
                        match rule {
                            MergeRule::ImportWins => jar[idx] = c.clone(),
                            MergeRule::KeepNewest => {
                                if c.created > jar[idx].created {
                                    jar[idx] = c.clone();
                                }
                            }
                            MergeRule::KeepExisting => {}
                        }
                    }
                    None => {
                        jar.push(c.clone());
                        cookies += 1;
                    }
                }
                touched = true;
            }
            if touched {
                jars += 1;
            }
        }
        (jars, cookies, conflicts)
    }
}
