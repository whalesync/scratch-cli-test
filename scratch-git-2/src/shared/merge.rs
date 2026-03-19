/// 3-way merge of file contents with conflict resolution using "ours" strategy.
/// Returns the merged string, or an error message on failure.
pub fn merge_file_contents(base: &str, ours: &str, theirs: &str) -> Result<String, String> {
    // Short-circuit cases
    if ours == base {
        return Ok(theirs.to_string());
    }
    if theirs == base {
        return Ok(ours.to_string());
    }
    if ours == theirs {
        return Ok(ours.to_string());
    }

    use gix::merge::blob::builtin_driver;
    use gix::merge::blob::builtin_driver::text::{Conflict, Labels, Options};

    let mut out = Vec::new();
    let mut input = imara_diff::intern::InternedInput::new(&[][..], &[][..]);

    let _resolution = builtin_driver::text(
        &mut out,
        &mut input,
        Labels::default(),
        ours.as_bytes(),
        base.as_bytes(),
        theirs.as_bytes(),
        Options {
            conflict: Conflict::ResolveWithOurs,
            diff_algorithm: imara_diff::Algorithm::Histogram,
        },
    );

    String::from_utf8(out).map_err(|e| format!("Merge result not UTF-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ours_changed() {
        let result = merge_file_contents("base", "ours changed", "base").unwrap();
        assert_eq!(result, "ours changed");
    }

    #[test]
    fn only_theirs_changed() {
        let result = merge_file_contents("base", "base", "theirs changed").unwrap();
        assert_eq!(result, "theirs changed");
    }

    #[test]
    fn both_changed_identically() {
        let result = merge_file_contents("base", "same", "same").unwrap();
        assert_eq!(result, "same");
    }

    #[test]
    fn no_changes() {
        let result = merge_file_contents("same", "same", "same").unwrap();
        assert_eq!(result, "same");
    }

    #[test]
    fn non_conflicting_changes_to_different_lines() {
        let base = "line1\nline2\nline3\n";
        let ours = "line1 changed\nline2\nline3\n";
        let theirs = "line1\nline2\nline3 changed\n";
        let result = merge_file_contents(base, ours, theirs).unwrap();
        assert_eq!(result, "line1 changed\nline2\nline3 changed\n");
    }

    #[test]
    fn conflicting_changes_resolved_with_ours() {
        let base = "line1\nline2\nline3\n";
        let ours = "line1\nours edit\nline3\n";
        let theirs = "line1\ntheirs edit\nline3\n";
        let result = merge_file_contents(base, ours, theirs).unwrap();
        // Conflict resolved with "ours" strategy
        assert!(result.contains("ours edit"));
        assert!(!result.contains("<<<<"));
    }

    #[test]
    fn empty_base_both_add_content() {
        let base = "";
        let ours = "hello\n";
        let theirs = "world\n";
        let result = merge_file_contents(base, ours, theirs).unwrap();
        // Both added content — ours wins on conflict
        assert!(result.contains("hello"));
    }

    #[test]
    fn multiline_non_overlapping_edits() {
        let base = "a\nb\nc\nd\ne\nf\n";
        let ours = "A\nb\nc\nd\ne\nf\n"; // changed first line
        let theirs = "a\nb\nc\nd\ne\nF\n"; // changed last line
        let result = merge_file_contents(base, ours, theirs).unwrap();
        assert_eq!(result, "A\nb\nc\nd\ne\nF\n");
    }
}
