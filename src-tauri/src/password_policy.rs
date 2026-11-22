//! The same rules as src/shared/passwordPolicy.ts. The UI shows them, the backend enforces them.

use std::sync::LazyLock;

use regex::Regex;

pub const MIN_MASTER_PASSWORD_LENGTH: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasswordRule {
    Length,
    Digit,
    Special,
}

impl PasswordRule {
    pub fn text(self) -> String {
        match self {
            PasswordRule::Length => format!("At least {MIN_MASTER_PASSWORD_LENGTH} characters"),
            PasswordRule::Digit => "At least one number".into(),
            PasswordRule::Special => "At least one special character (like ! ? - # €)".into(),
        }
    }
}

static DIGIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{N}").unwrap());
// Anything that is not a letter, a number or whitespace counts as special, so umlauts do not.
static SPECIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\s]").unwrap());

/// Rules the password does not meet yet, in display order. Empty means the password is acceptable.
pub fn problems(password: &str) -> Vec<PasswordRule> {
    let mut out = Vec::new();
    if password.chars().count() < MIN_MASTER_PASSWORD_LENGTH {
        out.push(PasswordRule::Length);
    }
    if !DIGIT.is_match(password) {
        out.push(PasswordRule::Digit);
    }
    if !SPECIAL.is_match(password) {
        out.push(PasswordRule::Special);
    }
    out
}

/// Fails with e.g. "Master password needs: at least one number" when a rule is not met.
pub fn assert_strong(password: &str, what: &str) -> crate::error::Result<()> {
    let p = problems(password);
    if p.is_empty() {
        return Ok(());
    }
    let list: Vec<String> = p.iter().map(|r| r.text().to_lowercase()).collect();
    Err(crate::error::Error::msg(format!("{what} needs: {}", list.join(", "))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use PasswordRule::*;

    #[test]
    fn reports_every_missing_rule_in_order() {
        assert_eq!(problems(""), vec![Length, Digit, Special]);
        assert_eq!(problems("abcdefghijkl"), vec![Digit, Special]);
        assert_eq!(problems("abcdefghijk1"), vec![Special]);
        assert_eq!(problems("abcdefghij1!"), Vec::<PasswordRule>::new());
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert_eq!(problems("ääääääääää1!"), Vec::<PasswordRule>::new());
        assert_eq!(problems("😀😀😀😀😀😀😀😀😀1!"), vec![Length]);
    }

    #[test]
    fn umlauts_and_spaces_are_not_special() {
        assert_eq!(problems("äöüäöüäöü 123"), vec![Special]);
        assert_eq!(problems("abcdefghij1€"), Vec::<PasswordRule>::new());
    }

    #[test]
    fn error_lists_the_rules() {
        let e = assert_strong("short", "Master password").unwrap_err().to_string();
        assert_eq!(e, "Master password needs: at least 12 characters, at least one number, at least one special character (like ! ? - # €)");
    }
}
