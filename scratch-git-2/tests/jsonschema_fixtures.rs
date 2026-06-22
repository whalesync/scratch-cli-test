/// Fixture-driven tests for the `enforce_schema` built-in validator.
///
/// Each subdirectory of `tests/fixtures/jsonschema/` is one test case.
/// Tests invoke `scratchmd validation dry-run` with inline JSON so they exercise
/// the real binary end-to-end without needing a lib target.
///
/// ## Standard cases (`pass.json` / `fail.json`)
/// `pass.json` must produce zero violations; `fail.json` must produce ≥ 1.
///
/// ## Custom-code cases (`gap_*` directories)
/// These were originally named "gap" because pure JSON Schema alone would miss
/// them. `enforce_schema` catches them via the hand-rolled required check
/// (null and empty string are treated as missing). The `tricky.json` in each
/// directory must produce ≥ 1 violation — confirming the custom check works.
///
/// To add a new case: create a subdirectory with `schema.json` + `pass.json` +
/// `fail.json`. No changes to this file are needed.
use std::fs;
use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn fixtures_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jsonschema")
}

fn load_json(path: &Path) -> serde_json::Value {
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid JSON in {}: {e}", path.display()))
}

/// Run `scratchmd validation dry-run` with fully-inline JSON and return violations.
/// Each violation is `(field_path, message)`.
fn run_enforce_schema(
    schema: &serde_json::Value,
    record: &serde_json::Value,
) -> Vec<(String, String)> {
    let binary = env!("CARGO_BIN_EXE_scratchmd");
    let validation = serde_json::json!([{ "validator": "enforce_schema" }]);

    let output = Command::new(binary)
        .args([
            "validation",
            "dry-run",
            "--record",
            &record.to_string(),
            "--validation",
            &validation.to_string(),
            "--schema",
            &schema.to_string(),
        ])
        .output()
        .unwrap_or_else(|e| panic!("failed to run scratchmd: {e}"));

    if !output.status.success() && output.stdout.trim_ascii().is_empty() {
        panic!(
            "scratchmd validation dry-run failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let violations: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).unwrap_or_default();

    violations
        .iter()
        .filter_map(|v| {
            let field = v.get("field_path")?.as_str()?.to_string();
            let msg = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            Some((field, msg))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Standard cases
// ---------------------------------------------------------------------------

fn assert_pass(case: &str) {
    let dir = fixtures_dir().join(case);
    let schema = load_json(&dir.join("schema.json"));
    let record = load_json(&dir.join("pass.json"));
    let violations = run_enforce_schema(&schema, &record);
    assert!(
        violations.is_empty(),
        "case '{case}' pass.json: expected no violations, got {violations:?}"
    );
}

fn assert_fail(case: &str) {
    let dir = fixtures_dir().join(case);
    let schema = load_json(&dir.join("schema.json"));
    let record = load_json(&dir.join("fail.json"));
    let violations = run_enforce_schema(&schema, &record);
    assert!(
        !violations.is_empty(),
        "case '{case}' fail.json: expected ≥1 violation, got none"
    );
}

macro_rules! fixture_test {
    ($name:ident) => {
        #[test]
        fn $name() {
            let case = stringify!($name);
            assert_pass(case);
            assert_fail(case);
        }
    };
}

fixture_test!(type_string);
fixture_test!(type_number);
fixture_test!(type_boolean);
fixture_test!(type_object);
fixture_test!(type_array);
fixture_test!(array_items_type);
fixture_test!(format_date);
fixture_test!(format_datetime);
fixture_test!(format_email);
fixture_test!(single_select_enum);
fixture_test!(multi_select_enum);
fixture_test!(additional_property_unknown);
fixture_test!(required_missing);
fixture_test!(null_not_allowed);

// ---------------------------------------------------------------------------
// Custom-code regression tests (formerly "gap" tests)
//
// Pure JSON Schema would miss these cases — they are caught by the hand-rolled
// required check in enforce_schema which treats null and "" as missing.
// If these start failing it means the custom check was removed or broken.
// ---------------------------------------------------------------------------

fn assert_custom_code_catches(case: &str, filename: &str) {
    let dir = fixtures_dir().join(case);
    let schema = load_json(&dir.join("schema.json"));
    let record = load_json(&dir.join(filename));
    let violations = run_enforce_schema(&schema, &record);
    assert!(
        !violations.is_empty(),
        "case '{case}/{filename}': expected the hand-rolled check to catch this, got no violations — \
         check that enforce_schema still treats null/\"\" as missing for required fields"
    );
}

#[test]
fn gap_required_null() {
    // { "title": null } on a required NON-nullable field — JSON Schema passes (key
    // present; null conformance errors are skipped), hand-rolled check catches
    // (null = missing). A required *nullable* field's null is intentionally clean;
    // see the `required_nullable_*` unit tests in builtin.rs.
    assert_custom_code_catches("gap_required_null", "tricky.json");
}

#[test]
fn gap_required_empty_string() {
    // { "title": "" } — JSON Schema passes (valid string), hand-rolled check catches ("" = missing).
    assert_custom_code_catches("gap_required_empty_string", "tricky.json");
}
