use rand::Rng;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static DIACRITICS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\u{0300}-\u{036f}]").unwrap());
static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static NON_ALNUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9 -]").unwrap());
static MULTI_HYPHEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-+").unwrap());

/// Slugify a string for use as a filename.
///
/// Port of `_normalize_filename` from `sync_engine.py:513-521`.
/// Unicode NFD normalize, strip diacritics, lowercase, slug.
pub fn normalize_filename(name: &str) -> String {
    // NFD normalize
    let s: String = name.nfd().collect();
    // Remove diacritics
    let s = DIACRITICS_RE.replace_all(&s, "");
    // Lowercase and trim
    let s = s.to_lowercase();
    let s = s.trim().to_string();
    // Replace whitespace with hyphens
    let s = WHITESPACE_RE.replace_all(&s, "-");
    // Remove non-alphanumeric (keep spaces and hyphens)
    let s = NON_ALNUM_RE.replace_all(&s, "");
    // Collapse multiple hyphens
    let s = MULTI_HYPHEN_RE.replace_all(&s, "-");
    s.to_string()
}

/// Generate a unique .json filename. Prefer slug, fall back to ID, deduplicate.
///
/// Port of `_resolve_filename` from `sync_engine.py:524-535`.
pub fn resolve_filename(slug_value: Option<&str>, record_id: &str, used_names: &mut HashSet<String>) -> String {
    let base = match slug_value {
        Some(s) if !s.trim().is_empty() => normalize_filename(s),
        _ => record_id.to_string(),
    };

    let mut candidate = format!("{}.json", base);
    if used_names.contains(&candidate) {
        candidate = format!("{}-{}.json", base, record_id);
    }
    used_names.insert(candidate.clone());
    candidate
}

/// Replace `/`, `\`, and null bytes in a remote ID for safe use as a filename.
///
/// Port of `_safe_filename` from `engine.py:306`.
pub fn safe_filename(remote_id: &str) -> String {
    remote_id.replace('/', "_").replace('\\', "_").replace('\0', "")
}

/// Generate a temporary publish ID matching Python `secrets.token_urlsafe(8)`.
///
/// Produces `spub_<11 url-safe base64 chars>`.
pub fn temp_publish_id() -> String {
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill(&mut bytes);
    let encoded = base64_url_encode(&bytes);
    format!("spub_{}", encoded)
}

/// URL-safe base64 encode without padding, matching Python's `base64.urlsafe_b64encode`.
fn base64_url_encode(data: &[u8]) -> String {
    use std::io::Write;
    let mut buf = Vec::new();
    {
        let mut encoder = Base64Encoder::new(&mut buf);
        encoder.write_all(data).unwrap();
        encoder.finish();
    }
    String::from_utf8(buf).unwrap()
}

/// Minimal URL-safe base64 encoder (no padding).
struct Base64Encoder<'a> {
    out: &'a mut Vec<u8>,
    buf: [u8; 3],
    buf_len: usize,
}

impl<'a> Base64Encoder<'a> {
    fn new(out: &'a mut Vec<u8>) -> Self {
        Self {
            out,
            buf: [0u8; 3],
            buf_len: 0,
        }
    }

    fn finish(&mut self) {
        if self.buf_len > 0 {
            let mut block = [0u8; 3];
            block[..self.buf_len].copy_from_slice(&self.buf[..self.buf_len]);
            let chars = Self::encode_block(&block);
            let output_len = match self.buf_len {
                1 => 2,
                2 => 3,
                _ => 4,
            };
            for c in &chars[..output_len] {
                self.out.push(*c);
            }
        }
    }

    fn encode_block(block: &[u8; 3]) -> [u8; 4] {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let n = ((block[0] as u32) << 16) | ((block[1] as u32) << 8) | (block[2] as u32);
        [
            TABLE[((n >> 18) & 0x3F) as usize],
            TABLE[((n >> 12) & 0x3F) as usize],
            TABLE[((n >> 6) & 0x3F) as usize],
            TABLE[(n & 0x3F) as usize],
        ]
    }
}

impl<'a> std::io::Write for Base64Encoder<'a> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let mut i = 0;
        while i < data.len() {
            self.buf[self.buf_len] = data[i];
            self.buf_len += 1;
            i += 1;
            if self.buf_len == 3 {
                let chars = Self::encode_block(&self.buf);
                self.out.extend_from_slice(&chars);
                self.buf_len = 0;
            }
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Check if a string looks like a pending publish ID.
pub fn is_pending_publish_id(id: &str) -> bool {
    id.starts_with("spub_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_filename_basic() {
        assert_eq!(normalize_filename("Hello World"), "hello-world");
    }

    #[test]
    fn test_normalize_filename_diacritics() {
        assert_eq!(normalize_filename("café résumé"), "cafe-resume");
    }

    #[test]
    fn test_normalize_filename_special_chars() {
        assert_eq!(normalize_filename("Hello!@#World"), "helloworld");
    }

    #[test]
    fn test_normalize_filename_multiple_spaces() {
        assert_eq!(normalize_filename("hello   world"), "hello-world");
    }

    #[test]
    fn test_normalize_filename_multiple_hyphens() {
        assert_eq!(normalize_filename("hello---world"), "hello-world");
    }

    #[test]
    fn test_resolve_filename_with_slug() {
        let mut used = HashSet::new();
        assert_eq!(resolve_filename(Some("Hello World"), "id1", &mut used), "hello-world.json");
    }

    #[test]
    fn test_resolve_filename_without_slug() {
        let mut used = HashSet::new();
        assert_eq!(resolve_filename(None, "rec123", &mut used), "rec123.json");
    }

    #[test]
    fn test_resolve_filename_dedup() {
        let mut used = HashSet::new();
        assert_eq!(resolve_filename(Some("test"), "id1", &mut used), "test.json");
        assert_eq!(resolve_filename(Some("test"), "id2", &mut used), "test-id2.json");
    }

    #[test]
    fn test_resolve_filename_empty_slug() {
        let mut used = HashSet::new();
        assert_eq!(resolve_filename(Some("  "), "id1", &mut used), "id1.json");
    }

    #[test]
    fn test_safe_filename() {
        assert_eq!(safe_filename("path/to/file"), "path_to_file");
        assert_eq!(safe_filename("path\\to\\file"), "path_to_file");
        assert_eq!(safe_filename("normal"), "normal");
    }

    #[test]
    fn test_temp_publish_id_format() {
        let id = temp_publish_id();
        assert!(id.starts_with("spub_"));
        assert!(id.len() > 5);
    }

    #[test]
    fn test_is_pending_publish_id() {
        assert!(is_pending_publish_id("spub_abc123"));
        assert!(!is_pending_publish_id("rec123"));
        assert!(!is_pending_publish_id(""));
    }
}
