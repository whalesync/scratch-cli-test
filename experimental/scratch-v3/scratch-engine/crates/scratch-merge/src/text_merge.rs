use similar::TextDiff;

/// Performs a three-way line-level merge of base, local, and remote text content.
/// On conflict (overlapping changes from both sides), the local version wins.
///
/// If `base` is `None`, both sides created the file independently -- local wins
/// for conflicting regions, remote additions are appended where possible.
pub fn merge_text(base: Option<&[u8]>, local: &[u8], remote: &[u8]) -> Vec<u8> {
    let base = match base {
        Some(b) => b,
        None => {
            // No common ancestor -- local wins entirely when both sides created.
            return local.to_vec();
        }
    };

    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);

    let local_edits = compute_edits(&base_lines, &local_lines);
    let remote_edits = compute_edits(&base_lines, &remote_lines);

    let merged = apply_edits(&base_lines, &local_edits, &remote_edits);
    merged.into_bytes()
}

/// Represents a replacement of base lines `[start, end)` with new lines.
#[derive(Debug, Clone)]
struct Edit {
    /// Inclusive start index in base.
    start: usize,
    /// Exclusive end index in base.
    end: usize,
    /// Replacement lines (empty vec means pure deletion).
    lines: Vec<String>,
}

/// Computes the set of edit regions that transform `base` into `target`.
///
/// Uses the `similar` crate for line-level diffing (replaces Go's go-diff).
fn compute_edits(base: &[String], target: &[String]) -> Vec<Edit> {
    let base_text = base.join("\n");
    let target_text = target.join("\n");

    let diff = TextDiff::configure()
        .newline_terminated(false)
        .diff_lines(&base_text, &target_text);

    let mut edits: Vec<Edit> = Vec::new();
    let mut base_line: usize = 0;

    for group in diff.grouped_ops(0) {
        for op in &group {
            match op {
                similar::DiffOp::Equal { old_index, len, .. } => {
                    // Ensure base_line is in sync.
                    base_line = old_index + len;
                }
                similar::DiffOp::Delete {
                    old_index, old_len, ..
                } => {
                    base_line = old_index + old_len;
                    edits.push(Edit {
                        start: *old_index,
                        end: old_index + old_len,
                        lines: Vec::new(),
                    });
                }
                similar::DiffOp::Insert {
                    old_index,
                    new_index,
                    new_len,
                    ..
                } => {
                    let new_lines: Vec<String> = target[*new_index..*new_index + new_len]
                        .iter()
                        .cloned()
                        .collect();
                    // If the last edit was a delete ending at this position, merge into a replace.
                    if let Some(last) = edits.last_mut() {
                        if last.end == *old_index && last.lines.is_empty() {
                            last.lines = new_lines;
                            continue;
                        }
                    }
                    edits.push(Edit {
                        start: *old_index,
                        end: *old_index,
                        lines: new_lines,
                    });
                    let _ = base_line; // base_line doesn't advance on insert
                }
                similar::DiffOp::Replace {
                    old_index,
                    old_len,
                    new_index,
                    new_len,
                    ..
                } => {
                    let new_lines: Vec<String> = target[*new_index..*new_index + new_len]
                        .iter()
                        .cloned()
                        .collect();
                    edits.push(Edit {
                        start: *old_index,
                        end: old_index + old_len,
                        lines: new_lines,
                    });
                    base_line = old_index + old_len;
                }
            }
        }
    }

    edits
}

/// Walks through base lines and applies non-overlapping edits from both local
/// and remote. When edits overlap, local wins.
fn apply_edits(base: &[String], local_edits: &[Edit], remote_edits: &[Edit]) -> String {
    let mut result: Vec<String> = Vec::new();
    let mut li: usize = 0;
    let mut ri: usize = 0;
    let mut base_line: usize = 0;

    while base_line <= base.len() {
        let le = if li < local_edits.len() {
            Some(&local_edits[li])
        } else {
            None
        };
        let re = if ri < remote_edits.len() {
            Some(&remote_edits[ri])
        } else {
            None
        };

        // No more edits -- append remaining base lines and break.
        if le.is_none() && re.is_none() {
            if base_line < base.len() {
                result.extend_from_slice(&base[base_line..]);
            }
            break;
        }

        // Determine the next edit start position.
        let mut next_start = base.len();
        if let Some(e) = le {
            if e.start < next_start {
                next_start = e.start;
            }
        }
        if let Some(e) = re {
            if e.start < next_start {
                next_start = e.start;
            }
        }

        // Copy unchanged base lines up to the next edit.
        if base_line < next_start {
            result.extend_from_slice(&base[base_line..next_start]);
            base_line = next_start;
        }

        // Check for overlapping edits.
        if let (Some(le_ref), Some(re_ref)) = (le, re) {
            if le_ref.start < re_ref.end && re_ref.start < le_ref.end {
                // Overlap -- local wins.
                if !le_ref.lines.is_empty() {
                    result.extend_from_slice(&le_ref.lines);
                }
                // Advance past both edits.
                let advance_to = le_ref.end.max(re_ref.end);
                base_line = advance_to;
                li += 1;
                // Skip all remote edits consumed by this overlap.
                while ri < remote_edits.len() && remote_edits[ri].start < advance_to {
                    ri += 1;
                }
                continue;
            }
        }

        // Non-overlapping: apply whichever edit comes first.
        if let Some(le_ref) = le {
            if re.is_none() || le_ref.start <= re.unwrap().start {
                if !le_ref.lines.is_empty() {
                    result.extend_from_slice(&le_ref.lines);
                }
                base_line = le_ref.end;
                li += 1;
                continue;
            }
        }

        if let Some(re_ref) = re {
            if !re_ref.lines.is_empty() {
                result.extend_from_slice(&re_ref.lines);
            }
            base_line = re_ref.end;
            ri += 1;
        }
    }

    result.join("\n")
}

/// Splits data into lines, normalizing `\r\n` and `\r` to `\n`.
pub fn split_lines(data: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(data);
    if s.is_empty() {
        return Vec::new();
    }
    let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
    normalized.split('\n').map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_no_base_returns_local() {
        let local = b"local content";
        let remote = b"remote content";
        let result = merge_text(None, local, remote);
        assert_eq!(result, local.to_vec());
    }

    #[test]
    fn test_merge_identical_files() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline2\nline3";
        let remote = b"line1\nline2\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(String::from_utf8_lossy(&result), "line1\nline2\nline3");
    }

    #[test]
    fn test_merge_only_local_changed() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nmodified\nline3";
        let remote = b"line1\nline2\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "line1\nmodified\nline3"
        );
    }

    #[test]
    fn test_merge_only_remote_changed() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline2\nline3";
        let remote = b"line1\nremote-changed\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "line1\nremote-changed\nline3"
        );
    }

    #[test]
    fn test_merge_non_overlapping_changes() {
        let base = b"line1\nline2\nline3\nline4\nline5";
        let local = b"LOCAL1\nline2\nline3\nline4\nline5";
        let remote = b"line1\nline2\nline3\nline4\nREMOTE5";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "LOCAL1\nline2\nline3\nline4\nREMOTE5"
        );
    }

    #[test]
    fn test_merge_overlapping_edits_local_wins() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nlocal-wins\nline3";
        let remote = b"line1\nremote-loses\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "line1\nlocal-wins\nline3"
        );
    }

    #[test]
    fn test_merge_local_addition() {
        let base = b"line1\nline3";
        let local = b"line1\nline2\nline3";
        let remote = b"line1\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "line1\nline2\nline3"
        );
    }

    #[test]
    fn test_merge_remote_addition() {
        let base = b"line1\nline3";
        let local = b"line1\nline3";
        let remote = b"line1\nline2\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(
            String::from_utf8_lossy(&result),
            "line1\nline2\nline3"
        );
    }

    #[test]
    fn test_merge_local_deletion() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline3";
        let remote = b"line1\nline2\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(String::from_utf8_lossy(&result), "line1\nline3");
    }

    #[test]
    fn test_merge_remote_deletion() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline2\nline3";
        let remote = b"line1\nline3";
        let result = merge_text(Some(base), local, remote);
        assert_eq!(String::from_utf8_lossy(&result), "line1\nline3");
    }

    #[test]
    fn test_split_lines_empty() {
        let result = split_lines(b"");
        assert!(result.is_empty());
    }

    #[test]
    fn test_split_lines_crlf() {
        let result = split_lines(b"a\r\nb\r\nc");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_split_lines_cr_only() {
        let result = split_lines(b"a\rb\rc");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_split_lines_lf() {
        let result = split_lines(b"a\nb\nc");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_merge_both_add_different_lines_at_end() {
        let base = b"line1";
        let local = b"line1\nlocal-new";
        let remote = b"line1\nremote-new";
        let result = merge_text(Some(base), local, remote);
        let result_str = String::from_utf8_lossy(&result);
        // Both added at the same position -- local wins for conflicting region
        assert!(result_str.contains("local-new"));
    }

    #[test]
    fn test_merge_crlf_handling() {
        let base = b"line1\r\nline2\r\nline3";
        let local = b"line1\r\nmodified\r\nline3";
        let remote = b"line1\r\nline2\r\nline3";
        let result = merge_text(Some(base), local, remote);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("modified"));
    }
}
