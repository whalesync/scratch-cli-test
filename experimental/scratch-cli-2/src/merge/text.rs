use similar::{DiffTag, TextDiff};

/// A replacement of base lines [start, end) with new lines.
struct Edit {
    start: usize,
    end: usize,
    lines: Vec<String>,
}

/// Performs a three-way line-level merge of base, local, and remote text content.
/// On conflict (overlapping changes from both sides), the local version wins.
///
/// If base is None, both sides created the file independently — local wins entirely.
pub fn merge_text(base: Option<&[u8]>, local: &[u8], remote: &[u8]) -> Vec<u8> {
    let base = match base {
        Some(b) => b,
        None => return local.to_vec(), // No common ancestor — local wins.
    };

    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);

    let local_edits = compute_edits(&base_lines, &local_lines);
    let remote_edits = compute_edits(&base_lines, &remote_lines);

    let result = apply_edits(&base_lines, &local_edits, &remote_edits);
    result.into_bytes()
}

/// Split text into lines, normalizing CRLF.
fn split_lines(data: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(data);
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    if s.is_empty() {
        return vec![];
    }
    s.split('\n').map(|l| l.to_string()).collect()
}

/// Compute the set of edit regions that transform base into target.
fn compute_edits(base: &[String], target: &[String]) -> Vec<Edit> {
    let base_text = base.join("\n");
    let target_text = target.join("\n");

    let diff = TextDiff::configure()
        .algorithm(similar::Algorithm::Myers)
        .diff_lines(&base_text, &target_text);

    let mut edits = Vec::new();

    for op in diff.ops() {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        match tag {
            DiffTag::Equal => {}
            DiffTag::Delete => {
                edits.push(Edit {
                    start: old_range.start,
                    end: old_range.end,
                    lines: vec![],
                });
            }
            DiffTag::Insert => {
                let new_lines = target[new_range.start..new_range.end].to_vec();
                edits.push(Edit {
                    start: old_range.start,
                    end: old_range.start,
                    lines: new_lines,
                });
            }
            DiffTag::Replace => {
                let new_lines = target[new_range.start..new_range.end].to_vec();
                edits.push(Edit {
                    start: old_range.start,
                    end: old_range.end,
                    lines: new_lines,
                });
            }
        }
    }

    edits
}

/// Walk through base lines and apply non-overlapping edits from both local and remote.
/// When edits overlap, local wins.
fn apply_edits(base: &[String], local_edits: &[Edit], remote_edits: &[Edit]) -> String {
    let mut result: Vec<String> = Vec::new();
    let mut li = 0;
    let mut ri = 0;
    let mut base_line = 0;

    while base_line <= base.len() {
        let le = local_edits.get(li);
        let re = remote_edits.get(ri);

        // No more edits — append remaining base lines.
        if le.is_none() && re.is_none() {
            if base_line < base.len() {
                result.extend_from_slice(&base[base_line..]);
            }
            break;
        }

        // Determine next edit start.
        let mut next_start = base.len();
        if let Some(e) = le {
            next_start = next_start.min(e.start);
        }
        if let Some(e) = re {
            next_start = next_start.min(e.start);
        }

        // Copy unchanged base lines up to next edit.
        if base_line < next_start {
            result.extend_from_slice(&base[base_line..next_start]);
            base_line = next_start;
        }

        // Check for overlapping edits.
        if let (Some(le_ref), Some(re_ref)) = (le, re) {
            let le_end = le_ref.end.max(le_ref.start); // start == end for pure inserts
            let re_end = re_ref.end.max(re_ref.start);
            if le_ref.start == re_ref.start || (le_ref.start < re_end && re_ref.start < le_end) {
                // Overlap or same position — local wins.
                result.extend_from_slice(&le_ref.lines);
                let advance_to = le_ref.end.max(re_ref.end);
                base_line = advance_to;
                li += 1;
                while ri < remote_edits.len() && remote_edits[ri].start < advance_to {
                    ri += 1;
                }
                continue;
            }
        }

        // Non-overlapping: apply whichever edit comes first.
        if let Some(le_ref) = le {
            if re.is_none() || le_ref.start <= re.unwrap().start {
                result.extend_from_slice(&le_ref.lines);
                base_line = le_ref.end;
                li += 1;
                continue;
            }
        }
        if let Some(re_ref) = re {
            result.extend_from_slice(&re_ref.lines);
            base_line = re_ref.end;
            ri += 1;
        }
    }

    result.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Basic scenarios ----

    #[test]
    fn no_base_local_wins() {
        let local = b"local content";
        let remote = b"remote content";
        assert_eq!(merge_text(None, local, remote), local.to_vec());
    }

    #[test]
    fn no_changes() {
        let base = b"line1\nline2\nline3";
        assert_eq!(merge_text(Some(base), base, base), base.to_vec());
    }

    #[test]
    fn only_remote_changed() {
        let base = b"line1\nline2\nline3";
        let remote = b"line1\nchanged\nline3";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn only_local_changed() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nlocal\nline3";
        assert_eq!(merge_text(Some(base), local, base), local.to_vec());
    }

    #[test]
    fn both_changed_different_regions() {
        let base = b"line1\nline2\nline3\nline4\nline5";
        let local = b"line1\nlocal2\nline3\nline4\nline5";
        let remote = b"line1\nline2\nline3\nline4\nremote5";
        let expected = b"line1\nlocal2\nline3\nline4\nremote5";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    #[test]
    fn conflict_local_wins() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nlocal\nline3";
        let remote = b"line1\nremote\nline3";
        let expected = b"line1\nlocal\nline3";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    // ---- Insertion tests ----

    #[test]
    fn remote_inserts_lines() {
        let base = b"line1\nline3";
        let remote = b"line1\nline2\nline3";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn local_inserts_lines() {
        let base = b"line1\nline3";
        let local = b"line1\ninserted\nline3";
        assert_eq!(merge_text(Some(base), local, base), local.to_vec());
    }

    #[test]
    fn both_insert_different_positions() {
        let base = b"A\nB\nC\nD\nE";
        let local = b"A\nX\nB\nC\nD\nE";
        let remote = b"A\nB\nC\nD\nY\nE";
        let expected = b"A\nX\nB\nC\nD\nY\nE";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    // ---- Deletion tests ----

    #[test]
    fn remote_deletes_lines() {
        let base = b"line1\nline2\nline3";
        let remote = b"line1\nline3";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn local_deletes_lines() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline3";
        assert_eq!(merge_text(Some(base), local, base), local.to_vec());
    }

    #[test]
    fn both_delete_same_line() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nline3";
        let remote = b"line1\nline3";
        let expected = b"line1\nline3";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    // ---- Multi-line conflict ----

    #[test]
    fn multi_line_conflict_local_wins() {
        let base = b"A\nB\nC\nD";
        let local = b"A\nX\nY\nD";
        let remote = b"A\nP\nQ\nD";
        let expected = b"A\nX\nY\nD";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    // ---- Edge cases ----

    #[test]
    fn empty_files() {
        let base = b"";
        let local = b"";
        let remote = b"";
        assert_eq!(merge_text(Some(base), local, remote), b"".to_vec());
    }

    #[test]
    fn single_line_no_newline() {
        let base = b"hello";
        assert_eq!(merge_text(Some(base), base, base), base.to_vec());
    }

    #[test]
    fn single_line_changed_by_remote() {
        let base = b"hello";
        let remote = b"world";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn single_line_conflict() {
        let base = b"hello";
        let local = b"local";
        let remote = b"remote";
        assert_eq!(merge_text(Some(base), local, remote), local.to_vec());
    }

    #[test]
    fn local_adds_to_empty_base() {
        let base = b"";
        let local = b"new content";
        let remote = b"";
        assert_eq!(merge_text(Some(base), local, remote), local.to_vec());
    }

    #[test]
    fn remote_adds_to_empty_base() {
        let base = b"";
        let local = b"";
        let remote = b"new content";
        assert_eq!(merge_text(Some(base), local, remote), remote.to_vec());
    }

    // ---- CRLF handling ----

    #[test]
    fn crlf_normalized() {
        let base = b"line1\r\nline2\r\nline3";
        let local = b"line1\nline2\nline3";
        // After CRLF normalization, these should be treated the same.
        assert_eq!(merge_text(Some(base), local, local), local.to_vec());
    }

    // ---- split_lines ----

    #[test]
    fn split_lines_basic() {
        assert_eq!(split_lines(b"a\nb\nc"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_lines_crlf() {
        assert_eq!(split_lines(b"a\r\nb\r\nc"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_lines_empty() {
        let result: Vec<String> = vec![];
        assert_eq!(split_lines(b""), result);
    }

    #[test]
    fn split_lines_trailing_newline() {
        assert_eq!(split_lines(b"a\nb\n"), vec!["a", "b", ""]);
    }

    #[test]
    fn split_lines_single_line() {
        assert_eq!(split_lines(b"hello"), vec!["hello"]);
    }

    // ---- Larger file merges ----

    #[test]
    fn ten_line_file_non_overlapping_edits() {
        let base = b"1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
        let local = b"1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10";
        let remote = b"1\n2\n3\n4\n5\n6\n7\n8\nNINE\n10";
        let expected = b"1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }

    #[test]
    fn append_at_end_by_remote() {
        let base = b"line1\nline2";
        let remote = b"line1\nline2\nline3";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn append_at_end_by_local() {
        let base = b"line1\nline2";
        let local = b"line1\nline2\nline3";
        assert_eq!(merge_text(Some(base), local, base), local.to_vec());
    }

    #[test]
    fn prepend_at_start_by_remote() {
        let base = b"line2\nline3";
        let remote = b"line1\nline2\nline3";
        assert_eq!(merge_text(Some(base), base, remote), remote.to_vec());
    }

    #[test]
    fn identical_changes_both_sides() {
        let base = b"A\nB\nC";
        let local = b"A\nX\nC";
        let remote = b"A\nX\nC";
        let expected = b"A\nX\nC";
        assert_eq!(merge_text(Some(base), local, remote), expected.to_vec());
    }
}
