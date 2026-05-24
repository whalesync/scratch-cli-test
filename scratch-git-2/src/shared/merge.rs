// scratchmd's three-way merge path was removed in Slice D
// (docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md). The
// service binary still uses `merge_file_contents` for its rebase machinery,
// so the module stays — but the scratchmd build sees the whole chain as
// dead. `#![allow(dead_code)]` keeps the warnings off without per-fn noise.
#![allow(dead_code)]

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

    if let Some(merged_json) = try_merge_json_objects(base, ours, theirs)? {
        return Ok(merged_json);
    }

    merge_text_contents(base, ours, theirs)
}

fn merge_text_contents(base: &str, ours: &str, theirs: &str) -> Result<String, String> {
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

fn try_merge_json_objects(base: &str, ours: &str, theirs: &str) -> Result<Option<String>, String> {
    let base_value = match serde_json::from_str::<serde_json::Value>(base) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let our_value = match serde_json::from_str::<serde_json::Value>(ours) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let their_value = match serde_json::from_str::<serde_json::Value>(theirs) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    if !matches!(base_value, serde_json::Value::Object(_))
        || !matches!(our_value, serde_json::Value::Object(_))
        || !matches!(their_value, serde_json::Value::Object(_))
    {
        return Ok(None);
    }

    let merged = merge_json_value(Some(&base_value), Some(&our_value), Some(&their_value))
        .ok_or_else(|| "JSON object merge unexpectedly removed the root object".to_string())?;

    serde_json::to_string_pretty(&merged)
        .map(|s| Some(s + "\n"))
        .map_err(|e| format!("Failed to serialize merged JSON: {}", e))
}

fn merge_json_value(
    base: Option<&serde_json::Value>,
    ours: Option<&serde_json::Value>,
    theirs: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    if ours == base {
        return theirs.cloned();
    }
    if theirs == base {
        return ours.cloned();
    }
    if ours == theirs {
        return ours.cloned();
    }

    match (base, ours, theirs) {
        (
            Some(serde_json::Value::Object(base_obj)),
            Some(serde_json::Value::Object(our_obj)),
            Some(serde_json::Value::Object(their_obj)),
        ) => Some(serde_json::Value::Object(merge_json_object(
            base_obj, our_obj, their_obj,
        ))),
        _ => ours.cloned().or_else(|| theirs.cloned()),
    }
}

fn merge_json_object(
    base_obj: &serde_json::Map<String, serde_json::Value>,
    our_obj: &serde_json::Map<String, serde_json::Value>,
    their_obj: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut merged = serde_json::Map::new();
    let mut seen = std::collections::HashSet::new();

    for key in their_obj
        .keys()
        .chain(our_obj.keys())
        .chain(base_obj.keys())
    {
        if seen.insert(key.as_str()) {
            if let Some(value) =
                merge_json_value(base_obj.get(key), our_obj.get(key), their_obj.get(key))
            {
                merged.insert(key.clone(), value);
            }
        }
    }

    merged
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

    #[derive(serde::Deserialize)]
    struct MergeFixture {
        mb: serde_json::Value,
        ours: serde_json::Value,
        theirs: serde_json::Value,
        expected: serde_json::Value,
        expected_text_merge: Option<serde_json::Value>,
    }

    // String fields are used as raw strings; object/array/etc fields are pretty-printed.
    fn fixture_to_str(v: &serde_json::Value) -> String {
        match v {
            serde_json::Value::String(s) => s.clone(),
            _ => serde_json::to_string_pretty(v).unwrap(),
        }
    }

    // String expected values are compared to the raw merge result; others are parsed then compared.
    fn fixture_matches(result: &str, expected: &serde_json::Value) -> bool {
        match expected {
            serde_json::Value::String(s) => result == s,
            _ => serde_json::from_str::<serde_json::Value>(result)
                .map(|v| v == *expected)
                .unwrap_or(false),
        }
    }

    fn fixture_display(v: &serde_json::Value) -> String {
        match v {
            serde_json::Value::String(s) => s.clone(),
            _ => serde_json::to_string(v).unwrap(),
        }
    }

    #[test]
    fn json_merge_fixtures() {
        let fixture_dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/shared/testdata/merge");

        let mut entries: Vec<_> = std::fs::read_dir(&fixture_dir)
            .expect("testdata/merge dir must exist")
            .map(|e| e.expect("dir entry").path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        entries.sort();

        assert!(!entries.is_empty(), "no fixtures found in {fixture_dir:?}");

        let mut failures = Vec::new();

        for path in entries {
            let content = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {path:?}: {e}"));
            let fixture: MergeFixture = serde_json::from_str(&content)
                .unwrap_or_else(|e| panic!("invalid fixture {path:?}: {e}"));

            let mb_str = fixture_to_str(&fixture.mb);
            let ours_str = fixture_to_str(&fixture.ours);
            let theirs_str = fixture_to_str(&fixture.theirs);
            let name = path.file_name().unwrap().to_string_lossy();

            let result = merge_file_contents(&mb_str, &ours_str, &theirs_str)
                .unwrap_or_else(|e| panic!("{name}: merge_file_contents failed: {e}"));

            if !fixture_matches(&result, &fixture.expected) {
                failures.push(format!(
                    "FAIL {name}\n  expected: {}\n  got:      {result}",
                    fixture_display(&fixture.expected),
                ));
            }

            if let Some(expected_text) = &fixture.expected_text_merge {
                let text_result = merge_text_contents(&mb_str, &ours_str, &theirs_str)
                    .unwrap_or_else(|e| panic!("{name}: merge_text_contents failed: {e}"));
                if !fixture_matches(&text_result, expected_text) {
                    failures.push(format!(
                        "FAIL {name} (expected_text_merge)\n  expected: {}\n  got:      {text_result}",
                        fixture_display(expected_text),
                    ));
                }
            }
        }

        if !failures.is_empty() {
            panic!("json merge fixture failures:\n\n{}", failures.join("\n\n"));
        }
    }
}
