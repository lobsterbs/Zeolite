//! RFC 6265 5.1.1 cookie-date parsing.
//!
//! Exact port of the app parser (cookies.ts parseCookieDate, the
//! tough-cookie token algorithm) with the documented deviations:
//! the RFC-optional seconds field, the 1601 year floor, and
//! day-of-month overflow normalized the way Date.UTC normalizes
//! it. Pure over the input: returns epoch milliseconds, no clock.

/// The RFC 6265 5.1.1 delimiter set. ':' is not a delimiter: it
/// lives inside the time token.
fn is_delim(c: char) -> bool {
    matches!(c, '\t' | ' '..='/' | ';'..='@' | '['..='`' | '{'..='~')
}

/// Leading run of at most `max` ASCII digits: (value, count).
fn leading_digits(tok: &str, max: usize) -> (i64, usize) {
    let mut value: i64 = 0;
    let mut count = 0;
    for b in tok.as_bytes() {
        if count >= max || !b.is_ascii_digit() {
            break;
        }
        value = value * 10 + i64::from(b - b'0');
        count += 1;
    }
    (value, count)
}

fn digit_at(tok: &str, i: usize) -> bool {
    tok.as_bytes().get(i).is_some_and(|b| b.is_ascii_digit())
}

/// The time token hh:mm[:ss], start-anchored with trailing junk
/// tolerated (the app regex is start-anchored only). Seconds are
/// RFC-optional and default to 0.
fn time_token(tok: &str) -> Option<(i64, i64, i64)> {
    let (hour, n1) = leading_digits(tok, 2);
    if n1 == 0 || tok.as_bytes().get(n1) != Some(&b':') {
        return None;
    }
    let rest = &tok[n1 + 1..];
    let (minute, n2) = leading_digits(rest, 2);
    if n2 == 0 {
        return None;
    }
    let tail = &rest[n2..];
    let second = match tail.strip_prefix(':') {
        Some(sec_part) => {
            let (sec, n3) = leading_digits(sec_part, 2);
            if n3 == 0 {
                return None;
            }
            sec
        }
        None => 0,
    };
    Some((hour, minute, second))
}

/// A 1-2 digit token not followed by a digit (^\d{1,2}(?!\d)).
fn day_token(tok: &str) -> Option<i64> {
    let (d, n) = leading_digits(tok, 2);
    if n == 0 || digit_at(tok, n) {
        return None;
    }
    Some(d)
}

/// A 2-4 digit token not followed by a digit with the two-digit
/// year windowing (>= 70 -> 19xx, else 20xx).
fn year_token(tok: &str) -> Option<i64> {
    let (y, n) = leading_digits(tok, 4);
    if !(2..=4).contains(&n) || digit_at(tok, n) {
        return None;
    }
    if n == 2 {
        return Some(if y >= 70 { 1900 + y } else { 2000 + y });
    }
    Some(y)
}

/// A three-letter month prefix, case-insensitive (0-based like
/// the app parser feeds Date.UTC).
fn month_token(tok: &str) -> Option<i64> {
    let b = tok.as_bytes();
    if b.len() < 3 {
        return None;
    }
    let pfx = [
        b[0].to_ascii_lowercase(),
        b[1].to_ascii_lowercase(),
        b[2].to_ascii_lowercase(),
    ];
    Some(match pfx {
        [b'j', b'a', b'n'] => 0,
        [b'f', b'e', b'b'] => 1,
        [b'm', b'a', b'r'] => 2,
        [b'a', b'p', b'r'] => 3,
        [b'm', b'a', b'y'] => 4,
        [b'j', b'u', b'n'] => 5,
        [b'j', b'u', b'l'] => 6,
        [b'a', b'u', b'g'] => 7,
        [b's', b'e', b'p'] => 8,
        [b'o', b'c', b't'] => 9,
        [b'n', b'o', b'v'] => 10,
        [b'd', b'e', b'c'] => 11,
        _ => return None,
    })
}

/// Days since the 1970 epoch for a proleptic Gregorian civil
/// date (Howard Hinnant's algorithm, valid over the full i64
/// range the parser can produce).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// RFC 6265 5.1.1. Tokens are split on the delimiter set, then
/// the first time, day, month and year tokens are located in
/// order (a token that supplies one field is never reconsidered
/// for another, matching the app parser's continue-on-match).
/// Returns epoch milliseconds, or None when the grammar rejects.
pub fn parse_cookie_date(s: &str) -> Option<i64> {
    let (mut hour, mut minute, mut second) = (-1i64, -1i64, -1i64);
    let (mut day, mut month, mut year) = (-1i64, -1i64, -1i64);
    let (mut found_time, mut found_day, mut found_month, mut found_year) =
        (false, false, false, false);
    let mut overflow_day: i64 = 0;
    for tok in s.split(is_delim) {
        if tok.is_empty() {
            continue;
        }
        if !found_time {
            if let Some((h, m, sec)) = time_token(tok) {
                hour = h;
                minute = m;
                second = sec;
                found_time = true;
                continue;
            }
        }
        if !found_day {
            if let Some(d) = day_token(tok) {
                if (1..=31).contains(&d) {
                    day = d;
                    found_day = true;
                    continue;
                }
                if overflow_day == 0 && (60..=99).contains(&d) {
                    overflow_day = d;
                    continue;
                }
            }
        }
        if !found_month {
            if let Some(m) = month_token(tok) {
                month = m;
                found_month = true;
                continue;
            }
        }
        if !found_year {
            if let Some(y) = year_token(tok) {
                year = y;
                found_year = true;
                continue;
            }
        }
    }
    /* day-of-month > 31: the 5.1.1 overflow rule (60-99 minus 1). */
    if overflow_day > 0 && day == -1 {
        day = overflow_day - 1;
        if (1..=31).contains(&day) {
            found_day = true;
        }
    }
    if !found_time || !found_day || !found_month || !found_year {
        return None;
    }
    if year < 1601 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    /* Date.UTC normalization: the civil month base plus the day
    offset reproduces its day-of-month overflow handling. */
    let days = days_from_civil(year, month + 1, 1) + day - 1;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000)
}
