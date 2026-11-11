//! zeolite-adblock: the Rust adblock filter engine for Zeolite (#613).
//!
//! Wraps the Brave adblock-rust engine behind the narrow surface Zeolite
//! needs: network decisions carrying redirect data URLs, per URL cosmetic
//! decisions, generic class/id hide rules, an input rule floor, and a
//! canary probe that proves the engine actually parsed a working filter
//! list. Scriptlets and procedural filters are counted and refused, never
//! executed.

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::{Engine, FilterSet};
use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

mod resources;

/// A request the canary probe must block when the engine parsed a real
/// filter list. Probed as an xhr request so it exercises the unscoped
/// ||doubleclick.net^$xhr rule uBlock Origin ships in filters-2021.
const CANARY_URL: &str = "https://adserver.doubleclick.net/adj/zeolite";
const CANARY_SOURCE: &str = "https://example.com/";

/// The outcome of one network request check.
#[derive(Debug, Serialize, Deserialize)]
pub struct NetworkDecision {
    /// Whether the request must be blocked.
    pub matched: bool,
    /// Whether an exception rule matched, preventing the block.
    pub exception: bool,
    /// A full data: URL to substitute, when a $redirect rule matched.
    pub redirect: Option<String>,
}

/// The cosmetic decision for one page URL. Generic class/id rules are
/// queried separately via hidden_css, since they depend on the page DOM.
#[derive(Debug, Serialize, Deserialize)]
pub struct CosmeticDecision {
    /// Whether any cosmetic action applies to this page.
    pub active: bool,
    /// A CSS rule per specific hide selector, sorted for byte stability.
    pub style: String,
    /// Procedural or scriptlet rules seen and refused, never executed.
    pub unsupported: usize,
    /// Whether the page opted out of generic cosmetic hiding.
    pub generichide: bool,
}

fn newline() -> char {
    10u8 as char
}

fn is_rule_line(line: &str) -> bool {
    !line.trim().is_empty() && !line.starts_with('!') && !line.starts_with('[')
}

fn css_rules(mut selectors: Vec<String>) -> String {
    selectors.sort();
    selectors.dedup();
    let nl = newline();
    let mut style = String::new();
    for selector in &selectors {
        style.push_str(selector);
        style.push_str("{display:none!important}");
        style.push(nl);
    }
    style
}

/// The native engine. The wasm build wraps this in WasmAdblock.
pub struct AdblockEngine {
    engine: Engine,
    input_rules: usize,
    scriptlet_rules: usize,
}

impl AdblockEngine {
    /// Builds an engine from raw filter list texts. Lines that are empty,
    /// comments, or list headers are excluded from the rule floor.
    pub fn from_lists(lists: &[String]) -> Result<Self, String> {
        let nl = newline();
        let mut joined = String::new();
        for list in lists {
            joined.push_str(list.as_str());
            joined.push(nl);
        }
        let mut set = FilterSet::new(false);
        set.add_filter_list(joined.clone(), ParseOptions::default());
        let mut engine = Engine::new_with_filter_set(set);
        engine.use_resources(resources::builtin_resources());
        let input_rules = joined.lines().filter(|l| is_rule_line(l)).count();
        let scriptlet_rules = joined
            .lines()
            .filter(|l| is_rule_line(l) && (l.contains("##+js(") || l.contains("#@#+js(")))
            .count();
        Ok(Self {
            engine,
            input_rules,
            scriptlet_rules,
        })
    }

    /// Checks one network request. Returns None when the URL cannot be
    /// parsed, which callers must treat as no match.
    pub fn check_network(
        &self,
        url: &str,
        source_url: &str,
        request_type: &str,
        method: &str,
    ) -> Option<NetworkDecision> {
        let request = Request::new(url, source_url, request_type, method).ok()?;
        let result = self.engine.check_network_request(&request);
        Some(NetworkDecision {
            matched: result.should_block(),
            exception: result.exception.is_some(),
            redirect: result.redirect,
        })
    }

    /// Builds the specific cosmetic decision for one page URL.
    pub fn cosmetic(&self, url: &str) -> CosmeticDecision {
        let found = self.engine.url_cosmetic_resources(url);
        let style = css_rules(found.hide_selectors.iter().cloned().collect());
        let unsupported = found.procedural_actions.len()
            + self.scriptlet_rules
            + usize::from(!found.injected_script.is_empty());
        CosmeticDecision {
            active: !style.is_empty() || unsupported > 0,
            style,
            unsupported,
            generichide: found.generichide,
        }
    }

    /// Generic hide rules for the classes and ids actually present on a
    /// page. Returns empty CSS when the page opted out via $generichide.
    pub fn hidden_css(&self, url: &str, classes: &[String], ids: &[String]) -> String {
        let found = self.engine.url_cosmetic_resources(url);
        if found.generichide {
            return String::new();
        }
        let selectors = self
            .engine
            .hidden_class_id_selectors(classes, ids, &found.exceptions);
        css_rules(selectors)
    }

    /// The rule floor: input lines that could be rules, before parsing.
    pub fn input_rules(&self) -> usize {
        self.input_rules
    }

    /// True only when the engine blocks the doubleclick canary request,
    /// which proves a real filter list was loaded and applied.
    pub fn canary_blocks(&self) -> bool {
        self.check_network(CANARY_URL, CANARY_SOURCE, "xhr", "get")
            .is_some_and(|d| d.matched)
    }
}

/// The wasm binding used by the Zeolite service worker. Loads lazily
/// when filter lists load, never at service worker boot (#562).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct WasmAdblock {
    inner: AdblockEngine,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl WasmAdblock {
    #[wasm_bindgen(constructor)]
    pub fn new(lists_json: String) -> Result<WasmAdblock, JsError> {
        let lists: Vec<String> =
            serde_json::from_str(&lists_json).map_err(|e| JsError::new(&e.to_string()))?;
        let inner = AdblockEngine::from_lists(&lists).map_err(|e| JsError::new(&e))?;
        Ok(Self { inner })
    }

    pub fn check_network(
        &self,
        url: String,
        source_url: String,
        request_type: String,
        method: String,
    ) -> Option<String> {
        self.inner
            .check_network(&url, &source_url, &request_type, &method)
            .and_then(|d| serde_json::to_string(&d).ok())
    }

    pub fn cosmetic(&self, url: String) -> String {
        serde_json::to_string(&self.inner.cosmetic(&url)).unwrap_or_default()
    }

    pub fn hidden_css(&self, url: String, classes_json: String, ids_json: String) -> String {
        let classes: Vec<String> = serde_json::from_str(&classes_json).unwrap_or_default();
        let ids: Vec<String> = serde_json::from_str(&ids_json).unwrap_or_default();
        self.inner.hidden_css(&url, &classes, &ids)
    }

    pub fn input_rules(&self) -> usize {
        self.inner.input_rules()
    }

    pub fn canary_blocks(&self) -> bool {
        self.inner.canary_blocks()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The canary must block under a uBlock Origin rule shape: the
    unscoped ||doubleclick.net^$xhr rule uAssets ships in
    filters-2021. This proves the probe exercises the xhr arm of
    the engine and that a $redirect rule counts as a block. */
    #[test]
    fn canary_blocks_on_ubo_doubleclick_xhr_rule() {
        let engine =
            AdblockEngine::from_lists(&[String::from("||doubleclick.net^$xhr,redirect=noop.txt")])
                .unwrap();
        assert!(engine.canary_blocks());
    }
}
