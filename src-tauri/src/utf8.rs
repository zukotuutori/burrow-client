/// Turns a byte stream into text without breaking characters that are split across chunks.
/// Invalid bytes become U+FFFD, like Node's StringDecoder.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        // An incomplete character at the end: keep it for the next chunk.
                        None => {
                            rest = after;
                            break;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_characters_together() {
        let bytes = "aé😀b".as_bytes();
        let mut d = Utf8Decoder::default();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.decode(&[*b]));
        }
        assert_eq!(out, "aé😀b");
    }

    #[test]
    fn replaces_invalid_bytes() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.decode(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }
}
