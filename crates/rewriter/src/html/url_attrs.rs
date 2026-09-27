//! Which attributes of which tags carry URLs. Case-insensitive matching;
//! `srcset` handled specially (comma-separated candidate list).

/// URL-bearing attributes per tag (lowercase tag, lowercase attr).
/// `href`/`src` are scoped to the tags that actually load or navigate:
/// a blanket match would rewrite e.g. `<a src>` or `<video href>`, which
/// carry no URL semantics in HTML.
pub fn is_url_attr(tag: &str, attr: &str) -> bool {
    match attr {
        // `use` and `image` load SVG sprite references (`<use
        // href="sprite.svg#symbol">`): without them every external
        // sprite reference stays a cross-origin URL the engine cannot
        // serve, and a page's icons silently vanish (ChatGPT's shell
        // sprites are the canonical case).
        "href" => matches!(tag, "a" | "area" | "link" | "base" | "use" | "image"),
        // SVG 1.1 spelling of the same references.
        "xlink:href" => matches!(tag, "use" | "image"),
        "src" => matches!(
            tag,
            "img"
                | "script"
                | "iframe"
                | "source"
                | "video"
                | "audio"
                | "embed"
                | "track"
                | "input"
        ),
        "action" | "formaction" | "poster" | "background" | "cite" | "lowsrc" => true,
        "data" => matches!(tag, "object"),
        "code" | "codebase" => matches!(tag, "applet"),
        "srcset" | "imagesrcset" => matches!(tag, "img" | "source"),
        _ => false,
    }
}

/// Rewrite a srcset value: `url 2x, url2 3x` -> rewritten pairs.
pub fn rewrite_srcset(srcset: &str, enc: &dyn Fn(&str) -> String) -> String {
    srcset
        .split(',')
        .map(|cand| {
            let cand = cand.trim();
            if cand.is_empty() {
                return String::new();
            }
            // First whitespace splits URL from descriptor.
            match cand.find(char::is_whitespace) {
                Some(i) => format!("{}{}", enc(&cand[..i]), &cand[i..]),
                None => enc(cand),
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attrs() {
        assert!(is_url_attr("a", "href"));
        assert!(is_url_attr("img", "srcset"));
        assert!(!is_url_attr("a", "src"));
        assert!(is_url_attr("object", "data"));
        assert!(!is_url_attr("video", "data"));
    }

    #[test]
    fn srcset() {
        let out = rewrite_srcset("a.png 1x, b.png 2x", &|u| format!("[{}]", u));
        assert_eq!(out, "[a.png] 1x, [b.png] 2x");
    }
}
