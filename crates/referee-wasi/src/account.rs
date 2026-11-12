//! NEAR account id rules (nearcore `AccountId`): account ids go into the players hash and the
//! ring, so a malformed one must be refused at enrolment rather than signed into a verdict.

pub const MIN_LEN: usize = 2;
pub const MAX_LEN: usize = 64;

pub fn validate(id: &str) -> Result<(), String> {
    if !(MIN_LEN..=MAX_LEN).contains(&id.len()) {
        return Err(format!("account id {id:?}: length must be {MIN_LEN}..={MAX_LEN}"));
    }
    // Parts of lowercase letters and digits, joined by single separators (`-`, `_` inside a
    // part's name, `.` between names); no separator at either end or next to another.
    let mut prev_sep = true;
    for c in id.chars() {
        let sep = matches!(c, '-' | '_' | '.');
        if sep {
            if prev_sep {
                return Err(format!(
                    "account id {id:?}: separators must sit between letters or digits"
                ));
            }
        } else if !(c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return Err(format!(
                "account id {id:?}: only a-z, 0-9, '-', '_' and '.' are allowed"
            ));
        }
        prev_sep = sep;
    }
    if prev_sep {
        return Err(format!("account id {id:?}: must not end with a separator"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_real_ids() {
        for id in [
            "alice.testnet",
            "a1.tail-dev-a38d13.testnet",
            "ok",
            "x_y.near",
            &"a".repeat(64),
        ] {
            assert!(validate(id).is_ok(), "{id}");
        }
    }

    #[test]
    fn rejects_bad_ids() {
        for id in [
            "a",
            "",
            "Alice.testnet",
            ".alice",
            "alice.",
            "al..ice",
            "a-.b",
            "a b",
            &"a".repeat(65),
        ] {
            assert!(validate(id).is_err(), "{id}");
        }
    }
}
