use crate::errors::AgentError;
use ring::digest;
fn invalid() -> AgentError {
    AgentError::code("siteInvalidResponse")
}
/// Scan bencode without re-encoding: the exact info dictionary bytes define the hash.
pub(super) fn info_hash(bytes: &[u8]) -> Result<String, AgentError> {
    fn string(bytes: &[u8], at: &mut usize) -> Result<(usize, usize), AgentError> {
        let start = *at;
        while *at < bytes.len() && bytes[*at].is_ascii_digit() {
            *at += 1;
        }
        if *at == start
            || bytes.get(*at) != Some(&b':')
            || (*at - start > 1 && bytes[start] == b'0')
        {
            return Err(invalid());
        }
        let length = std::str::from_utf8(&bytes[start..*at])
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .ok_or_else(invalid)?;
        *at += 1;
        let start = *at;
        *at = at
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        Ok((start, *at))
    }
    fn value(bytes: &[u8], at: &mut usize, depth: usize) -> Result<(), AgentError> {
        if depth > 32 {
            return Err(invalid());
        }
        match bytes.get(*at) {
            Some(b'i') => {
                *at += 1;
                let start = *at;
                while bytes.get(*at).is_some_and(|b| *b != b'e') {
                    *at += 1;
                }
                let text = std::str::from_utf8(&bytes[start..*at]).map_err(|_| invalid())?;
                if text.is_empty()
                    || text == "-"
                    || text == "-0"
                    || text.starts_with('0') && text.len() > 1
                    || text.starts_with("-0")
                    || !text
                        .strip_prefix('-')
                        .unwrap_or(text)
                        .bytes()
                        .all(|b| b.is_ascii_digit())
                    || bytes.get(*at) != Some(&b'e')
                {
                    return Err(invalid());
                }
                *at += 1;
            }
            Some(b'l' | b'd') => {
                let dictionary = bytes[*at] == b'd';
                let mut seen = std::collections::BTreeSet::new();
                *at += 1;
                while bytes.get(*at) != Some(&b'e') {
                    if dictionary {
                        let (begin, end) = string(bytes, at)?;
                        if !seen.insert(&bytes[begin..end]) {
                            return Err(invalid());
                        }
                    }
                    value(bytes, at, depth + 1)?;
                }
                *at += 1;
            }
            Some(b'0'..=b'9') => {
                string(bytes, at)?;
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
    if bytes.len() > 8 * 1024 * 1024 || bytes.first() != Some(&b'd') {
        return Err(invalid());
    }
    let mut at = 1;
    let mut info = None;
    while bytes.get(at) != Some(&b'e') {
        let (start, end) = string(bytes, &mut at)?;
        let begin = at;
        value(bytes, &mut at, 0)?;
        if &bytes[start..end] == b"info" {
            if info.is_some() || bytes.get(begin) != Some(&b'd') {
                return Err(invalid());
            }
            info = Some((begin, at));
        }
    }
    if at + 1 != bytes.len() {
        return Err(invalid());
    }
    let (start, end) = info.ok_or_else(invalid)?;
    let document = &bytes[start..end];
    let mut cursor = start + 1;
    let mut v1 = false;
    let mut v2 = false;
    while cursor < end - 1 {
        let (key_start, key_end) = string(bytes, &mut cursor)?;
        let begin = cursor;
        if &bytes[key_start..key_end] == b"pieces" {
            let (piece_start, piece_end) = string(bytes, &mut cursor)?;
            if (piece_end - piece_start) % 20 != 0 {
                return Err(invalid());
            }
            v1 = true;
        } else {
            value(bytes, &mut cursor, 0)?;
            if &bytes[key_start..key_end] == b"meta version" {
                v2 = &bytes[begin..cursor] == b"i2e";
            }
        }
    }
    if !v1 && !v2 {
        return Err(invalid());
    }
    let algorithm = if v1 {
        &digest::SHA1_FOR_LEGACY_USE_ONLY
    } else {
        &digest::SHA256
    };
    Ok(digest::digest(algorithm, document)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hashes_only_the_exact_info_dictionary_and_rejects_truncated_or_duplicate_info() {
        let input = b"d4:infod4:name1:a6:lengthi1e6:pieces0:ee";
        let expected: String = digest::digest(
            &digest::SHA1_FOR_LEGACY_USE_ONLY,
            b"d4:name1:a6:lengthi1e6:pieces0:e",
        )
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
        assert_eq!(info_hash(input).unwrap(), expected);
        assert!(info_hash(b"d4:infod4:name1:ae4:infodee").is_err());
        assert!(info_hash(b"d4:info").is_err());
        assert!(info_hash(b"<html>login</html>").is_err());
    }
}
#[cfg(test)]
mod protocol_tests {
    use super::*;
    #[test]
    fn v2_and_hybrid_hash_the_info_bytes_with_the_expected_algorithm() {
        let v2 = b"d12:meta versioni2e4:name1:ae";
        let envelope = [b"d4:info".as_slice(), v2, b"e"].concat();
        let expected: String = digest::digest(&digest::SHA256, v2)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(info_hash(&envelope).unwrap(), expected);
        assert_eq!(
            info_hash(b"d4:infod12:meta versioni2e6:pieces0:ee")
                .unwrap()
                .len(),
            40
        );
        for bad in [
            b"d4:infod4:name1:aee".as_slice(),
            b"d4:infod6:pieces1:xee",
            b"d4:infod6:pieces0:6:pieces0:ee",
            b"d4:infod12:meta versioni02eee",
        ] {
            assert!(info_hash(bad).is_err());
        }
    }
}
