//! RFC 6265 5.2 Set-Cookie parsing into typed attributes.
//!
//! Attributes land in struct fields, never in strings: the #599
//! attribute-smuggling class is unrepresentable at this boundary
//! instead of being filtered downstream.

use crate::date::parse_cookie_date;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SameSite {
    Strict,
    Lax,
    None,
}

/// The parsed 5.2 output: name, value and the typed attributes.
/// Optional attributes absent from the header are None.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
    pub max_age: Option<i64>,
    pub expires: Option<i64>,
}

impl SetCookie {
    /// The facade boundary (#599): a name and a value with no
    /// attribute interpretation at all, for callers that hold the
    /// parts separately (cookieStore.set). A value like
    /// "; Secure" stays a literal value.
    pub fn bare(name: &str, value: &str) -> SetCookie {
        SetCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: None,
            path: None,
            secure: false,
            http_only: false,
            same_site: None,
            max_age: None,
            expires: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseReject {
    Malformed,
    ControlCharacter,
}

fn has_control_char(s: &str) -> bool {
    s.bytes().any(|b| b < 0x20 || b == 0x7f)
}

/// ^-?\d+$ with the value clamped so a later now + max_age*1000
/// cannot overflow i64 (an absurd delta saturates instead of
/// panicking, the same effective behavior Number() gives).
fn parse_max_age(val: &str) -> Option<i64> {
    let (sign, digits) = match val.strip_prefix('-') {
        Some(d) => (-1i128, d),
        None => (1i128, val),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let v: i128 = digits
        .bytes()
        .fold(0i128, |acc, b| acc * 10 + i128::from(b - b'0'));
    let bound = i128::from((i64::MAX - 1) / 1000);
    Some((v.clamp(-bound, bound) * sign) as i64)
}

/// RFC 6265 5.2. Rejects a nameless pair (malformed) and control
/// characters in the name or value (#349: a CRLF in a stored value
/// poisons every later Cookie header built from it). Unknown or
/// undecodable attributes are ignored per 5.2.
pub fn parse_set_cookie(header: &str) -> Result<SetCookie, ParseReject> {
    let semi = header.find(';');
    let pair = match semi {
        Some(i) => header[..i].trim(),
        None => header.trim(),
    };
    let eq = match pair.find('=') {
        Some(0) | None => return Err(ParseReject::Malformed),
        Some(i) => i,
    };
    let name = pair[..eq].trim();
    if name.is_empty() {
        return Err(ParseReject::Malformed);
    }
    let value = pair[eq + 1..].trim();
    if has_control_char(name) || has_control_char(value) {
        return Err(ParseReject::ControlCharacter);
    }
    let mut out = SetCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: None,
        path: None,
        secure: false,
        http_only: false,
        same_site: None,
        max_age: None,
        expires: None,
    };
    let rest = match semi {
        Some(i) => &header[i + 1..],
        None => "",
    };
    for part in rest.split(';') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let (key, val) = match p.find('=') {
            Some(i) => (p[..i].trim().to_ascii_lowercase(), p[i + 1..].trim()),
            None => (p.trim().to_ascii_lowercase(), ""),
        };
        match key.as_str() {
            "domain" => {
                /* 5.2.3: an empty Domain is ignored (host-only). */
                if !val.is_empty() {
                    let d = val.strip_prefix('.').unwrap_or(val);
                    out.domain = Some(d.to_lowercase());
                }
            }
            "path" => {
                if val.starts_with('/') {
                    out.path = Some(val.to_string());
                }
            }
            "secure" => out.secure = true,
            "httponly" => out.http_only = true,
            "samesite" => {
                let sv = val.to_lowercase();
                out.same_site = match sv.as_str() {
                    "strict" => Some(SameSite::Strict),
                    "lax" => Some(SameSite::Lax),
                    "none" => Some(SameSite::None),
                    _ => None,
                };
            }
            "max-age" => out.max_age = parse_max_age(val),
            "expires" => {
                /* 5.1.1 grammar, never Date.parse. */
                if let Some(t) = parse_cookie_date(val) {
                    out.expires = Some(t);
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_value_and_typed_attributes() {
        let sc = parse_set_cookie("SID=31d4d96e407aad42; Path=/; Secure; HttpOnly; SameSite=Lax")
            .unwrap();
        assert_eq!(sc.name, "SID");
        assert_eq!(sc.value, "31d4d96e407aad42");
        assert_eq!(sc.path.as_deref(), Some("/"));
        assert!(sc.secure);
        assert!(sc.http_only);
        assert_eq!(sc.same_site, Some(SameSite::Lax));
        assert_eq!(sc.domain, None);
    }

    #[test]
    fn strips_leading_dots_and_lowercases_domain() {
        let sc = parse_set_cookie("a=1; Domain=.Example.COM").unwrap();
        assert_eq!(sc.domain.as_deref(), Some("example.com"));
    }

    #[test]
    fn empty_domain_attribute_is_ignored() {
        let sc = parse_set_cookie("e=1; Domain=").unwrap();
        assert_eq!(sc.domain, None);
    }

    #[test]
    fn validates_max_age_and_path_shapes() {
        assert_eq!(
            parse_set_cookie("a=1; Max-Age=-5").unwrap().max_age,
            Some(-5)
        );
        assert_eq!(
            parse_set_cookie("a=1; Max-Age=3600").unwrap().max_age,
            Some(3600)
        );
        assert_eq!(parse_set_cookie("a=1; Max-Age=abc").unwrap().max_age, None);
        assert_eq!(parse_set_cookie("a=1; Max-Age=").unwrap().max_age, None);
        assert_eq!(parse_set_cookie("a=1; Path=no-slash").unwrap().path, None);
    }

    #[test]
    fn rejects_nameless_and_control_character_cookies() {
        assert_eq!(parse_set_cookie("novalue"), Err(ParseReject::Malformed));
        assert_eq!(parse_set_cookie("=v"), Err(ParseReject::Malformed));
        assert_eq!(
            parse_set_cookie("a\u{0}b=1"),
            Err(ParseReject::ControlCharacter)
        );
        assert_eq!(
            parse_set_cookie("a=1\u{7f}"),
            Err(ParseReject::ControlCharacter)
        );
        assert_eq!(
            parse_set_cookie("a=1; b\u{1d}=x"),
            Ok(parse_set_cookie("a=1; b=x").unwrap())
        );
    }

    #[test]
    fn bare_parts_never_interpret_attributes() {
        let sc = SetCookie::bare("k", "; Secure");
        assert_eq!(sc.value, "; Secure");
        assert!(!sc.secure);
    }
}
