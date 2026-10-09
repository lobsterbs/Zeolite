//! Which attributes of which tags carry URLs. Case-insensitive matching;
//! `srcset` handled specially (WHATWG candidate parsing).

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
        // `script` is the SVG external-script spelling (`<script
        // href="lib.js">` in SVG2 markup); an HTML `<script>` carrying
        // href is already invalid, so rewriting it cannot break a
        // working page.
        "href" => matches!(
            tag,
            "a" | "area" | "link" | "base" | "use" | "image" | "script"
        ),
        // SVG 1.1 spelling of the same references.
        "xlink:href" => matches!(tag, "use" | "image" | "a" | "script"),
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
        // Obsolete but still URL-bearing when present.
        "longdesc" => matches!(tag, "img" | "iframe"),
        "manifest" => matches!(tag, "html"),
        "data" => matches!(tag, "object"),
        "code" | "codebase" => matches!(tag, "applet"),
        "srcset" | "imagesrcset" => matches!(tag, "img" | "source"),
        _ => false,
    }
}

/// SVG presentation attributes whose value is a `url(...)` paint or
/// filter reference. Fragment-only references (`url(#gradient)`) stay
/// client-side; external references are rewritten by
/// [`rewrite_svg_paint`]. Tag-agnostic: none of these names carry
/// non-URL semantics in HTML (`<input pattern>` is deliberately not
/// in this list - it is a regular expression, not a URL).
pub fn is_svg_paint_attr(_tag: &str, attr: &str) -> bool {
    matches!(
        attr,
        "fill"
            | "stroke"
            | "filter"
            | "clip-path"
            | "mask"
            | "marker"
            | "marker-start"
            | "marker-mid"
            | "marker-end"
    )
}

/// Challenge-provider script URLs whose <script src> must stay
/// provider-direct. Cloudflare Turnstile's api.js locates its own
/// <script> tag by the original src; a routed src breaks
/// self-location and the widget never injects (an infinite spinner
/// where the captcha should be). Mirrors the fetch-seam challenge
/// list in app/src/request.ts (isChallengeFrameUrl); only hosts with
/// a verified self-location requirement belong here - recaptcha and
/// hCaptcha load fine through the engine route today.
pub fn is_challenge_script_src(url: &str) -> bool {
    let host = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    host.eq_ignore_ascii_case("challenges.cloudflare.com")
}

/// Rewrite one `url(...)` SVG paint value through `enc`. Values that
/// are not a bare `url(...)` token pass through unchanged: plain
/// colors, `none`, fragment-only references (`url(#local)`, never a
/// request) and paint fallbacks (`url(#a) #333`). Only a fetchable
/// external reference is routed.
pub fn rewrite_svg_paint(value: &str, enc: &dyn Fn(&str) -> String) -> String {
    let t = value.trim();
    let Some(inner) = t.strip_prefix("url(") else {
        return value.to_string();
    };
    let Some(body) = inner.strip_suffix(')') else {
        return value.to_string();
    };
    let url = body.trim().trim_matches(|c| c == '\'' || c == '"');
    if url.is_empty() || url.starts_with('#') {
        return value.to_string();
    }
    format!("url('{}')", enc(url))
}

/// Rewrite a srcset value through `enc`, following the WHATWG "parse
/// a srcset attribute" candidate rules.
///
/// Issue #36: the old rewrite split the value on every comma, which
/// butchered data URLs (their base64 payload contains commas) and any
/// URL with a comma in it. The spec algorithm collects a URL as a
/// maximal run of NON-whitespace characters - commas inside that run
/// are part of the URL, and only a comma at the END of the run (the
/// last character before whitespace or end of input) separates
/// candidates. Descriptors after the URL are whitespace-separated
/// tokens; a descriptor token ending in a comma ends the candidate.
/// Malformed input degrades exactly the way the browser's own parser
/// degrades (e.g. `a.png, b.png` yields the candidate `a.png` with the
/// invalid descriptor `b.png`), because our output is re-parsed by the
/// same rules.
pub fn rewrite_srcset(srcset: &str, enc: &dyn Fn(&str) -> String) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut rest = srcset;
    'candidates: loop {
        // Skip ASCII whitespace and commas between candidates.
        let t = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if t.is_empty() {
            break;
        }
        // The URL is a maximal run of non-whitespace characters,
        // commas included. Only a trailing comma ends it.
        let tok_end = t.find(|c: char| c.is_ascii_whitespace()).unwrap_or(t.len());
        let mut url = &t[..tok_end];
        rest = &t[tok_end..];
        // A trailing comma on the URL token separates it from its
        // descriptors; otherwise a comma right after the whitespace
        // ends the candidate with no descriptors at all.
        let mut descs: Vec<&str> = Vec::new();
        let mut collect_descs = url.ends_with(',');
        if collect_descs {
            url = &url[..url.len() - 1];
        } else {
            let u = rest.trim_start();
            if let Some(after) = u.strip_prefix(',') {
                rest = after;
            } else {
                collect_descs = !u.is_empty();
            }
        }
        // Descriptors: whitespace-separated tokens. A comma anywhere
        // in a descriptor token finalizes the candidate (consumed by
        // the spec's descriptor parser); the non-whitespace run right
        // after it starts the next candidate's URL.
        if collect_descs {
            loop {
                let u = rest.trim_start();
                if u.is_empty() {
                    break;
                }
                let te = u.find(|c: char| c.is_ascii_whitespace()).unwrap_or(u.len());
                let dtok = &u[..te];
                rest = &u[te..];
                match dtok.find(',') {
                    Some(ci) => {
                        if ci > 0 {
                            descs.push(&dtok[..ci]);
                        }
                        // From right after the comma the next URL run
                        // starts (up to the same whitespace that ended
                        // this token, or the end of input).
                        rest = &u[ci + 1..];
                        break;
                    }
                    None => descs.push(dtok),
                }
            }
        }
        if !url.is_empty() {
            let mut cand = enc(url);
            for d in &descs {
                cand.push(' ');
                cand.push_str(d);
            }
            out.push(cand);
        }
        if rest.trim().is_empty() {
            break 'candidates;
        }
    }
    out.join(", ")
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
        assert!(is_url_attr("use", "href"));
        assert!(is_url_attr("use", "xlink:href"));
        assert!(is_url_attr("script", "href"));
        assert!(is_url_attr("html", "manifest"));
        assert!(!is_url_attr("body", "manifest"));
        assert!(is_svg_paint_attr("path", "fill"));
        assert!(!is_svg_paint_attr("input", "pattern"));
    }

    #[test]
    fn challenge_script_srcs() {
        // Turnstile's api.js must keep its provider src (self-location).
        assert!(is_challenge_script_src(
            "https://challenges.cloudflare.com/turnstile/v0/api.js"
        ));
        // Other challenge providers stay routed today; lookalike
        // hosts and relative URLs do not match.
        assert!(!is_challenge_script_src("https://hcaptcha.com/1/api.js"));
        assert!(!is_challenge_script_src(
            "https://www.google.com/recaptcha/api.js"
        ));
        assert!(!is_challenge_script_src(
            "https://example.com/challenges.cloudflare.com.evil"
        ));
        assert!(!is_challenge_script_src("relative/path.js"));
    }

    #[test]
    fn srcset() {
        let out = rewrite_srcset("a.png 1x, b.png 2x", &|u| format!("[{}]", u));
        assert_eq!(out, "[a.png] 1x, [b.png] 2x");
    }

    #[test]
    fn srcset_data_urls_keep_commas() {
        // Issue #36: a naive comma split turned this into the
        // "candidates" "data:image/png;base64,iVBORw0KGgoAAA 1x" and
        // "b.png 2x" with the data URL's tail mangled into a
        // descriptor. The spec keeps the whole non-whitespace run.
        let out = rewrite_srcset("data:image/png;base64,iVBORw0KGgoAAA 1x, b.png 2x", &|u| {
            format!("[{}]", u)
        });
        assert_eq!(out, "[data:image/png;base64,iVBORw0KGgoAAA] 1x, [b.png] 2x");
    }

    #[test]
    fn srcset_spec_separator_shapes() {
        let enc = |u: &str| format!("[{}]", u);
        // No space after the separating comma: the comma rides on the
        // descriptor token's tail.
        assert_eq!(
            rewrite_srcset("a.png 1x,b.png 2x", &enc),
            "[a.png] 1x, [b.png] 2x"
        );
        // No whitespace at all: one candidate whose URL contains a
        // comma (exactly how the browser reads it).
        assert_eq!(rewrite_srcset("a.png,b.png", &enc), "[a.png,b.png]");
        // Comma then space: spec parity - b.png is consumed as an
        // (invalid) descriptor of a.png, same as the browser parser.
        assert_eq!(rewrite_srcset("a.png, b.png", &enc), "[a.png] b.png");
        // Multiple descriptors: the spec collects tokens until one
        // ends with a comma, so without a comma this whole tail is
        // (invalid) descriptors of a.png, exactly as a browser reads
        // it.
        assert_eq!(
            rewrite_srcset("a.png 100w 1x, b.png 200w 2x", &enc),
            "[a.png] 100w 1x, [b.png] 200w 2x"
        );
    }

    #[test]
    fn svg_paint_values() {
        let enc = |u: &str| format!("[{}]", u);
        // Fragment-only references never reach the network.
        assert_eq!(rewrite_svg_paint("url(#grad)", &enc), "url(#grad)");
        // External sprite references are rewritten.
        assert_eq!(
            rewrite_svg_paint("url(sprite.svg#g)", &enc),
            "url('[sprite.svg#g]')"
        );
        assert_eq!(
            rewrite_svg_paint("url('https://cdn.example.net/f.svg#f')", &enc),
            "url('[https://cdn.example.net/f.svg#f]')"
        );
        // Non-url paint values and fallback paints pass through.
        assert_eq!(rewrite_svg_paint("none", &enc), "none");
        assert_eq!(rewrite_svg_paint("#ff0000", &enc), "#ff0000");
        assert_eq!(rewrite_svg_paint("url(#a) #333", &enc), "url(#a) #333");
    }
}
