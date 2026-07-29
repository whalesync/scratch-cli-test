use super::{
    FieldValidationContext, RecordValidationContext, RecordValidationResult, ValidationLevel,
    ValidationResult,
};
use crate::shared::index::extract_id_path;
use crate::shared::json_path::id_path_root;

/// Validates that a field value's string length is between optional `min` and `max` characters.
/// Non-string values are coerced to their JSON representation for length measurement.
/// Returns `None` when the value passes; `Some(Warning)` when it fails.
pub fn length(ctx: &FieldValidationContext) -> Option<ValidationResult> {
    let min = match ctx.args.get("min") {
        Some(value) => match value.as_u64() {
            Some(value) => Some(value as usize),
            None => return invalid_length_params(),
        },
        None => None,
    };
    let max = match ctx.args.get("max") {
        Some(value) => match value.as_u64() {
            Some(value) => Some(value as usize),
            None => return invalid_length_params(),
        },
        None => None,
    };

    if min.is_none() && max.is_none() {
        return invalid_length_params();
    }
    if min.zip(max).is_some_and(|(min, max)| min > max) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some("length: 'min' cannot be greater than 'max'".to_string()),
            description: None,
            fixable: false,
        });
    }

    let len = match &ctx.value {
        serde_json::Value::String(s) => s.chars().count(),
        serde_json::Value::Null => 0,
        other => other.to_string().len(),
    };

    if min.is_some_and(|min| len < min) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some(format!(
                "value is {} character{} (min {})",
                len,
                if len == 1 { "" } else { "s" },
                min.unwrap()
            )),
            description: None,
            fixable: false,
        });
    }
    if max.is_some_and(|max| len > max) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some(format!(
                "value is {} character{} (max {})",
                len,
                if len == 1 { "" } else { "s" },
                max.unwrap()
            )),
            description: None,
            fixable: false,
        });
    }
    None
}

/// Checks that a field value is present, non-null, and non-empty string.
///
/// Emits an **error** when:
/// - the field is absent from the record
/// - the field is `null`
/// - the field is an empty string (`""`)
///
/// Use this to enforce required values on fields that the schema does not
/// already list in `required` (e.g. optional fields that your workflow
/// still needs to have filled in before publishing).
///
/// Unlike `enforce_schema`'s required check, this field-scoped rule is
/// schema-agnostic — it has no access to the property schema, so it always
/// treats null and `""` as missing. That is the intended contract for an
/// explicitly opted-in `required` rule.
///
/// ```json
/// { "validator": "required", "field": "fields.Name" }
/// ```
pub fn required(ctx: &FieldValidationContext) -> Option<ValidationResult> {
    let is_missing = match &ctx.value {
        serde_json::Value::Null => true,
        serde_json::Value::String(s) if s.is_empty() => true,
        _ => false,
    };
    if is_missing {
        Some(ValidationResult {
            level: ValidationLevel::Error,
            message: Some(format!("field '{}' is required", ctx.field_path)),
            description: None,
            fixable: false,
        })
    } else {
        None
    }
}

fn invalid_length_params() -> Option<ValidationResult> {
    Some(ValidationResult {
        level: ValidationLevel::Warning,
        message: Some(
            "length: missing or invalid 'min'/'max' parameter (expected non-negative integers)"
                .to_string(),
        ),
        description: None,
        fixable: false,
    })
}

/// Enforces `required`, `x-scratch-readonly`, and `x-scratch-write-once`
/// constraints from `schema.json`.
///
/// Required check: a field is violated when it is absent from the record, or —
/// for a field whose schema does NOT permit null — when its value is null or an
/// empty string. A field whose schema allows null (`type:"null"`, a `type` array
/// containing "null", or an `anyOf`/`oneOf` branch permitting null) legitimately
/// holds a verbatim null/blank (e.g. Intercom's nullable-but-required
/// `team_assignee_id`), so those are not flagged. Empty string is treated like
/// null because the DB stores empty text for blank inputs and the connector would
/// never publish "".
///
/// Readonly check: a read-only field changed against master (existing record) OR
/// set at all on a new record emits a Warning — it is never user-writable.
///
/// Write-once check: a write-once field is editable while the record is NEW (no
/// master), so setting it then is clean; once the record EXISTS (master present)
/// a changed value emits a Warning. This is the create-only counterpart to
/// read-only. Both are advisory — the push code drops the rejected values.
///
/// Both the readonly and write-once checks recurse into nested object `properties`
/// (e.g. `location.lat`) AND into the non-null object member of an `anyOf`/`oneOf`
/// nullable-object union (DEV-10437 + DEV-10494), matching the desktop grid which
/// locks those nested cells. Array `items`/`$ref` are still not walked (no static
/// property name to annotate).
///
/// Results are deduplicated by path SEGMENT VECTOR, so a literal-dot top-level key
/// `"a.b"` stays distinct from a nested `a`→`b` (DEV-10495); at a shared path an
/// `Error` beats a `Warning` (DEV-10493), and equal severities keep the last
/// (hand-rolled) message. Results are advisory only — nothing here gates publishing.
///
/// Returns one `RecordValidationResult` per violated field. Clean records return an
/// empty Vec — no rows are written to the DB.
pub fn enforce_schema(ctx: &RecordValidationContext) -> Vec<RecordValidationResult> {
    enforce_schema_inner(ctx)
}

/// Accepts a value the JSON Schema `format: "uri"` keyword should treat as a URI for
/// Scratch's purposes. We deliberately accept MORE than RFC 3986's absolute-URI grammar
/// (which the jsonschema crate's built-in `uri` checker enforces, requiring a scheme):
/// many connectors map a "link/website/url" service field to `format: "uri"`, and those
/// services (e.g. Webflow's CMS Link field) store and return SCHEMELESS host strings
/// verbatim — `usecaucus.com`, `www.arcadia.solutions`. Per "preserve external data
/// fidelity" we must not flag a value the service legitimately returns, so a schemeless
/// host-shaped string is accepted as a valid `uri`.
///
/// We do NOT collapse to "any non-empty string": a value with whitespace, control
/// characters, or a literal `…`/`[…]` ellipsis (truncated-URL bad data we've seen in
/// real Webflow records) is still rejected, so genuine garbage keeps surfacing rather
/// than being silently masked ("surface failures; never silently succeed").
///
/// Accepts: any string with an explicit `scheme:` prefix (delegated to the standard
/// absolute-URI grammar via the crate's default behaviour — see below), AND any
/// schemeless string that is host-shaped: a dot-separated host (each label
/// alphanumeric or `-`, at least one dot) optionally followed by `:port`, a `/path`,
/// `?query`, or `#fragment`, with no whitespace, control chars, or non-URL characters.
fn scratch_uri_format_is_valid(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    // No whitespace or control characters anywhere — rejects "hello world" and any
    // value carrying a stray newline/tab. The `…` (U+2026) and other non-ASCII URL
    // junk are rejected by the ASCII gate below.
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }

    // A value with an explicit scheme (`scheme:rest`) is validated against the
    // standard absolute-URI grammar. We detect a scheme as RFC 3986 does
    // (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` before the first `:`, and that
    // `:` must come before any `/`, `?`, or `#` so a path like `foo.io/a:b` is NOT
    // read as the scheme `foo.io/a`).
    if let Some(colon_index) = value.find(':') {
        let candidate_scheme = &value[..colon_index];
        let scheme_ends_before_path_or_query = value[..colon_index].find(['/', '?', '#']).is_none();
        let is_valid_scheme = scheme_ends_before_path_or_query
            && !candidate_scheme.is_empty()
            && candidate_scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            && candidate_scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        if is_valid_scheme {
            // A value with a valid scheme is a URI for our purposes: the no-whitespace /
            // no-control gate above already rejected the truncated/garbage cases, and we
            // require something after the `scheme:` so a bare `http:` is rejected. We do
            // not re-derive the full RFC 3986 hier-part grammar — the crate doesn't expose
            // its built-in `uri` checker publicly, and the goal here is to WIDEN what `uri`
            // accepts (schemeless hosts), not to tighten the scheme-prefixed case.
            let part_after_scheme = &value[colon_index + 1..];
            return !part_after_scheme.is_empty() && value.is_ascii();
        }
    }

    // Schemeless: require a host-shaped prefix (dot-separated labels, at least one dot)
    // before any optional `:port` / `/path` / `?query` / `#fragment`. This accepts
    // `usecaucus.com`, `www.arcadia.solutions`, `foo.io/path?q=1` and rejects a bare
    // word, a single label, or anything with disallowed characters.
    let host_authority_end = value.find(['/', '?', '#', ':']).unwrap_or(value.len());
    let host_authority = &value[..host_authority_end];
    let host_labels: Vec<&str> = host_authority.split('.').collect();
    let host_is_dotted_and_well_formed = host_labels.len() >= 2
        && host_labels.iter().all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if !host_is_dotted_and_well_formed {
        return false;
    }
    // Everything after the host (path/query/fragment/port) must be printable ASCII
    // with no characters outside the unreserved/reserved/percent-encoding set we'd
    // expect in a URL — the no-whitespace/no-control gate above plus an ASCII check
    // is sufficient to reject the embedded-`…` truncated URLs.
    value.is_ascii()
}

/// Builds the JSON Schema validator used by `enforce_schema`, registering Scratch's
/// custom `uri` format (see `scratch_uri_format_is_valid`) so schemeless connector
/// links validate everywhere `format: "uri"` appears. `should_validate_formats(true)`
/// is required for ANY format — built-in or custom — to run.
fn build_validator_with_scratch_formats(
    schema: &serde_json::Value,
) -> Result<jsonschema::Validator, jsonschema::ValidationError<'static>> {
    jsonschema::options()
        .should_validate_formats(true)
        .with_format("uri", scratch_uri_format_is_valid)
        .build(schema)
}

fn enforce_schema_inner(ctx: &RecordValidationContext) -> Vec<RecordValidationResult> {
    let mut results = Vec::new();

    let schema_obj = match ctx.schema.get("schema") {
        Some(s) => s,
        None => return results,
    };

    // ── JSONSchema validation ─────────────────────────────────────────────────
    // Runs first so that the hand-rolled required/readonly checks below can
    // overwrite any overlapping field_path entries via INSERT OR REPLACE.
    //
    // For new records (no master), strip the id column from the required array
    // before passing to JSONSchema — the remote service assigns the id on first
    // publish, so missing id is expected and must not be flagged.
    {
        let modified: Option<serde_json::Value> = if ctx.master_record.is_none() {
            // DEV-10092: `idColumnRemoteId` was renamed `idPath`. Read the new name
            // first, falling back to the legacy name for schemas committed before
            // the rename. Drop the fallback once every workbook has re-pulled.
            ctx.schema
                .get("idPath")
                .or_else(|| ctx.schema.get("idColumnRemoteId"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.split('.').next())
                .map(|id_seg| {
                    let mut m = schema_obj.clone();
                    if let Some(req) = m.get_mut("required").and_then(|v| v.as_array_mut()) {
                        req.retain(|v| v.as_str() != Some(id_seg));
                    }
                    m
                })
        } else {
            None
        };
        let effective: &serde_json::Value = modified.as_ref().unwrap_or(schema_obj);

        if let Ok(validator) = build_validator_with_scratch_formats(effective) {
            for error in validator.iter_errors(&ctx.record) {
                // Skip required errors — the hand-rolled required check below
                // handles these with better precision: null and empty string are
                // also treated as missing, which JSON Schema does not catch.
                if matches!(
                    error.kind(),
                    jsonschema::error::ValidationErrorKind::Required { .. }
                ) {
                    continue;
                }
                // An empty string is the service's "blank/unset" sentinel — the same
                // value the required check below treats as missing. A blank value is a
                // verbatim "no value", not malformed data, so don't flag it for failing
                // a `format` (email/date/uri) check or the `anyOf` that wraps a nullable
                // formatted field. Many connectors return "" for an unset text field
                // (e.g. Moco's email columns); flagging those buries the real warnings.
                if error.instance().as_str() == Some("") {
                    continue;
                }
                // A present `null` is the service's verbatim "no value" — like the
                // empty-string blank above, not malformed data. Connector schemas
                // routinely type an optional field as non-nullable (e.g. Webflow
                // returns `null` for unset fields), and flagging every such null
                // buries the real warnings. A null on a *required* non-nullable
                // field is still caught by the hand-rolled required check below.
                if error.instance().is_null() {
                    continue;
                }
                let pointer = error.instance_path().to_string();
                // A blank ("" or null) nested inside an `anyOf`-wrapped (or otherwise
                // container-typed) field is not caught by the two leaf-level skips
                // above: the jsonschema crate collapses the failure into a single
                // `anyOf`/`type` error whose instance is the WHOLE container (e.g.
                // WordPress `acf`, typed `anyOf[object, array(maxItems:0)]`). The
                // leaf-level skips never see the `""`/`null` leaf, so an empty ACF
                // number field surfaces as a false positive at `field_path = acf`.
                // Extend the same blank exemption inward: when the failing instance is
                // a container and the error is an `anyOf`/container-`type` failure,
                // skip it only if the container fails SOLELY because of blank leaves —
                // re-validate a blank-stripped clone and require that no error remains
                // at the container. A genuinely-wrong nested value (e.g. a string where
                // a number is required) keeps an error alive and still surfaces.
                // (DEV-10540)
                let instance_is_container =
                    error.instance().is_object() || error.instance().is_array();
                let error_is_anyof_or_container_type = matches!(
                    error.kind(),
                    jsonschema::error::ValidationErrorKind::AnyOf { .. }
                        | jsonschema::error::ValidationErrorKind::Type { .. }
                );
                if instance_is_container
                    && error_is_anyof_or_container_type
                    && container_failure_is_only_nested_blanks(&validator, &ctx.record, &pointer)
                {
                    continue;
                }
                // Derive BOTH the dedup identity (segments) and the display string
                // from the same decoded JSON Pointer, so a JSONSchema error and a
                // hand-rolled readonly/write-once result at the same path agree on
                // identity (they dedup) AND on display. For ordinary keys this is
                // byte-identical to the old `trim('/').replace('/', ".")`; only keys
                // literally containing `/` or `~` now display their decoded form.
                let field_path_segments = json_pointer_to_segments(&pointer);
                let field_path = if field_path_segments.is_empty() {
                    "(record)".to_string()
                } else {
                    field_path_segments.join(".")
                };
                // A `format`-keyword failure (email/uri/date/date-time, or Scratch's
                // custom uri) is informational, not a hard error: the record holds the
                // service's verbatim value and most services (e.g. Notion) don't enforce
                // these formats. Surface it as a warning so the user is informed that the
                // data doesn't match the expectation, without the data being treated as
                // broken. A structural failure (wrong type, missing required) stays an
                // error. When the failure is purely format-caused we also replace the
                // crate's generic message — which for a nullable-wrapped field is the
                // opaque "… is not valid under any of the schemas listed in the 'anyOf'
                // keyword" — with a readable "<value> is not a valid <format>".
                let (level, message) = match collect_purely_format_caused_failures(
                    &error,
                    MAX_SCHEMA_PROPERTY_RECURSION_DEPTH,
                ) {
                    Some(format_failures) => (
                        ValidationLevel::Warning,
                        build_format_warning_message(&format_failures, || error.to_string()),
                    ),
                    None => (ValidationLevel::Error, error.to_string()),
                };
                results.push(RecordValidationResult {
                    field_path,
                    field_path_segments,
                    level,
                    message: Some(message),
                    description: None,
                    fixable: false,
                });
            }
        }
    }

    // ── Required check ────────────────────────────────────────────────────────
    if let Some(required) = schema_obj.get("required").and_then(|v| v.as_array()) {
        // The id column is assigned by the remote service on first publish.
        // New records (no master) won't have it yet — skip the required check
        // for it. `idColumnRemoteId` is a dot path (e.g. `"id.record_id"` for
        // Attio); compare against its first segment because the JSON Schema's
        // `required` array only lists top-level field names.
        let id_path = extract_id_path(&ctx.schema);
        let id_column_root = id_path.as_deref().map(id_path_root);
        let is_new_record = ctx.master_record.is_none();

        for field_val in required {
            let field_name = match field_val.as_str() {
                Some(s) => s,
                None => continue,
            };

            if is_new_record && id_column_root == Some(field_name) {
                continue;
            }

            let value = ctx.record.get(field_name);
            // Only treat null/empty as "missing" when the field's schema does NOT
            // permit null. A nullable-but-required field (e.g. Intercom's
            // `team_assignee_id: anyOf[string, null]`) legitimately holds a verbatim
            // null/blank — that is a value, not a missing one.
            let field_permits_null = schema_obj
                .get("properties")
                .and_then(|properties| properties.get(field_name))
                .map(schema_property_permits_null)
                .unwrap_or(false);
            let is_missing = match value {
                None => true,
                Some(serde_json::Value::Null) => !field_permits_null,
                Some(serde_json::Value::String(s)) if s.is_empty() => !field_permits_null,
                _ => false,
            };
            if is_missing {
                results.push(RecordValidationResult {
                    field_path: field_name.to_string(),
                    field_path_segments: vec![field_name.to_string()],
                    level: ValidationLevel::Error,
                    message: Some(format!(
                        "field '{}' is required but missing or null",
                        field_name
                    )),
                    description: None,
                    fixable: false,
                });
            }
        }
    }

    // ── Collect every annotated-or-not property at every depth ────────────────
    // The readonly and write-once checks below enforce their `x-scratch-*`
    // annotations on nested object subfields (e.g. `location.lat`), not only on
    // top-level fields — matching the desktop grid, which locks nested
    // write-once/readonly cells. We walk `properties` once into a flat list of
    // (path segments, property node) and reuse it for both checks. Path *segments*
    // are carried (not a pre-joined string) so value navigation uses the exact
    // keys; we join with '.' only for the display/`field_path`. See the
    // `enforce_schema` doc comment for the deferred-scope tickets (DEV-10493/4/5).
    let collected_properties: Vec<(Vec<String>, &serde_json::Value)> = {
        let mut out = Vec::new();
        if let Some(properties) = schema_obj.get("properties").and_then(|v| v.as_object()) {
            collect_schema_properties(
                properties,
                &[],
                MAX_SCHEMA_PROPERTY_RECURSION_DEPTH,
                &mut out,
            );
        }
        out
    };

    // ── Readonly check ────────────────────────────────────────────────────────
    for (path, props) in &collected_properties {
        if props.get("x-scratch-readonly").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        let field_path = path.join(".");
        let working = get_by_segments(&ctx.record, path);
        match &ctx.master_record {
            Some(master) => {
                // Existing record: warn if the value differs from master.
                let master_val = get_by_segments(master, path);
                if working != master_val {
                    results.push(RecordValidationResult {
                        field_path: field_path.clone(),
                        field_path_segments: path.clone(),
                        level: ValidationLevel::Warning,
                        message: Some("Updated read-only field".to_string()),
                        description: Some(format!(
                            "Field {} changed from {} to {}. The new value may cause an error when publishing.",
                            field_path,
                            format_validation_value(master_val),
                            format_validation_value(working)
                        )),
                        fixable: false,
                    });
                }
            }
            None => {
                // New record: warn if a readonly field has been set (remote assigns it).
                let is_set = match working {
                    None | Some(serde_json::Value::Null) => false,
                    _ => true,
                };
                if is_set {
                    results.push(RecordValidationResult {
                        field_path: field_path.clone(),
                        field_path_segments: path.clone(),
                        level: ValidationLevel::Warning,
                        message: Some("Updated read-only field".to_string()),
                        description: Some(format!(
                            "Field {} is read-only and will be ignored during publishing.",
                            field_path,
                        )),
                        fixable: false,
                    });
                }
            }
        }
    }

    // ── Write-once check ──────────────────────────────────────────────────────
    // A write-once field (`x-scratch-write-once`) may be set while the record is
    // NEW (no master) — that's the only time it can be written — but must not
    // change once the record exists remotely. So, unlike read-only, setting it on
    // a new record is expected and clean; we only warn when an EXISTING record's
    // value differs from master. See X_SCRATCH_WRITE_ONCE in @spinner/shared-types.
    for (path, props) in &collected_properties {
        if props.get("x-scratch-write-once").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        // On a new record (no master) write-once fields are editable — skip.
        let master = match &ctx.master_record {
            Some(master) => master,
            None => continue,
        };
        let field_path = path.join(".");
        let working = get_by_segments(&ctx.record, path);
        let master_val = get_by_segments(master, path);
        if working != master_val {
            results.push(RecordValidationResult {
                field_path: field_path.clone(),
                field_path_segments: path.clone(),
                level: ValidationLevel::Warning,
                message: Some("Updated write-once field".to_string()),
                description: Some(format!(
                    "Field {} is write-once (set on create only). The change from {} to {} will be ignored during publishing.",
                    field_path,
                    format_validation_value(master_val),
                    format_validation_value(working)
                )),
                fixable: false,
            });
        }
    }

    // Deduplicate by the path SEGMENT VECTOR (not the joined string), so a literal
    // top-level key "a.b" (segments ["a.b"]) stays distinct from a nested a→b
    // (["a","b"]) (DEV-10495). When two results share a key, keep the higher
    // SEVERITY — an Error always beats a Warning (DEV-10493), independent of push
    // order — and on EQUAL severity keep the LAST pushed, preserving the prior
    // behaviour where a hand-rolled readonly/write-once/required message overrides
    // the raw JSONSchema message for the same field.
    //
    // This dedup is what the in-memory `validate-record` dry-run returns. The
    // persisted `validation_results` table keys on the DISPLAY `field_path` string
    // (PK incl. field_path, validator_kind), so a literal-dot vs nested collision
    // still collapses to one row there; fully disambiguating the persisted index
    // would need a PK migration and is out of scope.
    //
    // Ordering: the FIRST occurrence of each key keeps its slot, so for the common
    // no-collision case the result order is identical to insertion order; only a
    // genuine same-key collision (rare, and latent until a connector annotates such
    // a field) moves a survivor.
    {
        let mut deduped: Vec<RecordValidationResult> = Vec::with_capacity(results.len());
        let mut output_index_by_segments: std::collections::HashMap<Vec<String>, usize> =
            std::collections::HashMap::new();
        for incoming in std::mem::take(&mut results) {
            match output_index_by_segments.get(&incoming.field_path_segments) {
                None => {
                    output_index_by_segments
                        .insert(incoming.field_path_segments.clone(), deduped.len());
                    deduped.push(incoming);
                }
                Some(&existing_index) => {
                    if severity_rank(incoming.level) >= severity_rank(deduped[existing_index].level)
                    {
                        deduped[existing_index] = incoming;
                    }
                }
            }
        }
        results = deduped;
    }

    results
}

/// Severity ordering for dedup: higher wins. An `Error` always outranks a `Warning`
/// at the same path (DEV-10493), regardless of the order they were pushed.
fn severity_rank(level: ValidationLevel) -> u8 {
    match level {
        ValidationLevel::Error => 1,
        ValidationLevel::Warning => 0,
    }
}

/// One string-`format` check that a value failed: the `format` keyword name (e.g.
/// `"email"`) and the offending value. Collected from a purely-format-caused validation
/// error to build a friendly "<value> is not a valid <format>" warning message.
struct FormatFailure {
    format_name: String,
    offending_value: serde_json::Value,
}

/// Returns `Some(failures)` when a JSON-schema validation error is caused SOLELY by string
/// `format` keyword(s) — directly (a `Format` error) or hidden inside an `anyOf`/`oneOf`
/// failure where relaxing the format constraint would let some branch match — and `None`
/// otherwise. The record holds the service's verbatim value and most services don't enforce
/// these formats, so a `format` mismatch is informational; `enforce_schema` emits it as a
/// warning, not an error (a structural failure — wrong type, missing required — stays an
/// error). `Some`/`None` therefore decides the level, and the returned `FormatFailure`s
/// drive the friendly message.
///
/// For a nullable-wrapped formatted field — `anyOf[{string, format}, {null}]`, the shape
/// TypeBox emits for an optional formatted column — the crate collapses the failure into a
/// single `AnyOf` error whose per-branch errors live in its public `context`; the string
/// branch fails ONLY on `format` while the null branch fails on `type`. "Some branch fails
/// only on format" means ignoring format would let that branch match, so the value's only
/// problem is the format, and we collect that branch's `FormatFailure`(s) (e.g. `email` for
/// a nullable email field, or `date` + `date-time` for Notion's two-branch date union). A
/// genuinely wrong type (e.g. a number in a `string|null` field) fails every branch on
/// `type` (format doesn't apply to non-strings) ⇒ no all-format branch ⇒ `None` ⇒ stays an
/// error. `OneOfMultipleValid` is intentionally excluded: matching more than one branch is a
/// structural ambiguity, not a format problem. The `!is_empty()` guard rejects a
/// vacuously-true empty (i.e. passing) branch. Bounded by `MAX_SCHEMA_PROPERTY_RECURSION_DEPTH`
/// so a pathological deeply-nested union can't recurse without end (on exhausting the budget
/// it returns `None` — stay an error).
fn collect_purely_format_caused_failures(
    error: &jsonschema::ValidationError,
    depth_budget: usize,
) -> Option<Vec<FormatFailure>> {
    match error.kind() {
        jsonschema::error::ValidationErrorKind::Format { format } => Some(vec![FormatFailure {
            format_name: format.clone(),
            offending_value: error.instance().clone().into_owned(),
        }]),
        jsonschema::error::ValidationErrorKind::AnyOf { context }
        | jsonschema::error::ValidationErrorKind::OneOfNotValid { context } => {
            if depth_budget == 0 {
                return None;
            }
            let mut failures: Vec<FormatFailure> = Vec::new();
            let mut found_purely_format_branch = false;
            for branch_errors in context {
                if branch_errors.is_empty() {
                    continue;
                }
                // A branch counts as purely-format only if EVERY one of its errors is.
                let mut branch_failures: Vec<FormatFailure> = Vec::new();
                let branch_is_purely_format = branch_errors.iter().all(|branch_error| {
                    match collect_purely_format_caused_failures(branch_error, depth_budget - 1) {
                        Some(branch_error_failures) => {
                            branch_failures.extend(branch_error_failures);
                            true
                        }
                        None => false,
                    }
                });
                if branch_is_purely_format {
                    found_purely_format_branch = true;
                    failures.append(&mut branch_failures);
                }
            }
            if found_purely_format_branch {
                Some(failures)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Builds a readable warning message for a value that failed string `format` check(s), e.g.
/// `"trash" is not a valid email` or `"2025" is not a valid date or date-time`. The value is
/// rendered as compact JSON (so strings keep their quotes, matching the crate's own format
/// message). When the failures reference more than one distinct offending value — rare;
/// multiple formatted leaves failing under one container — there is no single value to name,
/// so it returns `fallback()` (the crate's original message) rather than misattribute a value.
fn build_format_warning_message(
    failures: &[FormatFailure],
    fallback: impl FnOnce() -> String,
) -> String {
    let first_failure = match failures.first() {
        Some(failure) => failure,
        None => return fallback(),
    };
    let all_share_one_value = failures
        .iter()
        .all(|failure| failure.offending_value == first_failure.offending_value);
    if !all_share_one_value {
        return fallback();
    }
    // Distinct format names, in first-seen order (e.g. ["date", "date-time"]).
    let mut distinct_format_names: Vec<&str> = Vec::new();
    for failure in failures {
        if !distinct_format_names.contains(&failure.format_name.as_str()) {
            distinct_format_names.push(failure.format_name.as_str());
        }
    }
    format!(
        "{} is not a valid {}",
        first_failure.offending_value,
        join_with_or(&distinct_format_names),
    )
}

/// Joins items into an English list with a final "or": `["a"]` → `a`, `["a","b"]` →
/// `a or b`, `["a","b","c"]` → `a, b, or c`.
fn join_with_or(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [only] => only.to_string(),
        [first, second] => format!("{first} or {second}"),
        [all_but_last @ .., last] => format!("{}, or {}", all_but_last.join(", "), last),
    }
}

/// Splits an RFC-6901 JSON Pointer into its decoded path segments. `/a/b` →
/// `["a","b"]`; a literal key `"a.b"` arrives as `/a.b` → `["a.b"]` (so it stays
/// distinct from a nested `a`→`b`); the escapes `~1`→`/` then `~0`→`~` are decoded
/// in that RFC-mandated order. An empty pointer (whole-record error) → `[]`. Used
/// both as the dedup identity and (joined with `.`) as the display `field_path`, so
/// the JSONSchema producer and the hand-rolled producers agree on identity AND
/// display for the same field.
fn json_pointer_to_segments(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    pointer
        .split('/')
        .skip(1)
        .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn format_validation_value(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(value) => value.to_string(),
        None => "<missing>".to_string(),
    }
}

/// Returns `true` if a JSON Schema property node permits an explicit `null`:
/// `"type": "null"`, the array form `"type": ["string", "null"]`, or any branch
/// of an `anyOf` / `oneOf` that itself permits null. Conservative — an absent or
/// non-object node (or one with no recognizable `type`/`anyOf`/`oneOf`) returns
/// `false` and is treated as non-nullable. Used by the required check so a
/// present-but-null value on a schema-nullable field is not flagged as missing.
fn schema_property_permits_null(node: &serde_json::Value) -> bool {
    if let Some(type_value) = node.get("type") {
        if let Some(type_name) = type_value.as_str() {
            return type_name == "null";
        }
        if let Some(type_names) = type_value.as_array() {
            return type_names
                .iter()
                .any(|entry| entry.as_str() == Some("null"));
        }
    }
    for union_key in ["anyOf", "oneOf"] {
        if let Some(branches) = node.get(union_key).and_then(|value| value.as_array()) {
            if branches.iter().any(schema_property_permits_null) {
                return true;
            }
        }
    }
    false
}

/// Parity with the top-level `""` / `null` skips in `enforce_schema`: an empty
/// string or a JSON null is the service's verbatim "blank/unset" sentinel. An empty
/// object `{}` or array `[]` is a real value, never a blank.
fn is_blank_leaf(value: &serde_json::Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

/// Recursively removes every object entry whose value is a blank leaf (`""` / null),
/// descending into nested objects and into array elements. Scalar array elements are
/// left intact — removing them would shift indices and interact with `min`/`maxItems`.
/// Non-blank leaves are never touched, so any genuine violation survives a
/// re-validation of the stripped value. Bounded by `MAX_SCHEMA_PROPERTY_RECURSION_DEPTH`
/// so a pathological instance can't recurse without end. Returns `true` if it removed
/// at least one blank entry.
fn strip_blank_object_entries(node: &mut serde_json::Value, depth_budget: usize) -> bool {
    if depth_budget == 0 {
        return false;
    }
    let mut removed_any_blank = false;
    match node {
        serde_json::Value::Object(map) => {
            map.retain(|_key, value| {
                if is_blank_leaf(value) {
                    removed_any_blank = true;
                    false
                } else {
                    true
                }
            });
            for value in map.values_mut() {
                removed_any_blank |= strip_blank_object_entries(value, depth_budget - 1);
            }
        }
        serde_json::Value::Array(items) => {
            for value in items.iter_mut() {
                removed_any_blank |= strip_blank_object_entries(value, depth_budget - 1);
            }
        }
        _ => {}
    }
    removed_any_blank
}

/// Returns `true` when the container that failed validation at `container_pointer`
/// fails ONLY because of nested blank (`""` / null) leaves. Strips every blank object
/// entry from a clone of `record` at that pointer and re-validates the whole clone
/// with the SAME compiled `validator` (so `format` checks stay live and parity with
/// the top-level blank skips is preserved). Returns `false` — meaning surface the
/// original error — when the pointer can't be located, when no blank was stripped (so
/// blanks were not the cause), or when any error still remains at or under
/// `container_pointer` (a real, non-blank violation survives). Mirrors the top-level
/// `""` / null skips, extended to blanks nested inside `anyOf`/object container
/// failures. (DEV-10540)
fn container_failure_is_only_nested_blanks(
    validator: &jsonschema::Validator,
    record: &serde_json::Value,
    container_pointer: &str,
) -> bool {
    let mut blank_stripped_record = record.clone();
    let container = match blank_stripped_record.pointer_mut(container_pointer) {
        Some(container) => container,
        None => return false,
    };
    if !strip_blank_object_entries(container, MAX_SCHEMA_PROPERTY_RECURSION_DEPTH) {
        return false;
    }
    let nested_error_pointer_prefix = format!("{container_pointer}/");
    for remaining_error in validator.iter_errors(&blank_stripped_record) {
        let remaining_error_pointer = remaining_error.instance_path().to_string();
        if remaining_error_pointer == container_pointer
            || remaining_error_pointer.starts_with(&nested_error_pointer_prefix)
        {
            return false;
        }
    }
    true
}

/// Maximum depth `collect_schema_properties` descends through nested object
/// `properties`. Connector-generated schemas are shallow, acyclic trees (no
/// `$ref`), so this never fires in practice — it only bounds a pathological or
/// hand-authored schema so the recursion always terminates.
const MAX_SCHEMA_PROPERTY_RECURSION_DEPTH: usize = 32;

/// Resolves the non-null object member of an `anyOf`/`oneOf` nullable-object union —
/// the shape `anyOf: [{ "type": "object", "properties": {…} }, { "type": "null" }]`
/// that Shopify and others use for nullable nested objects. Returns the FIRST union
/// member that has `"type": "object"` AND an object `properties` map (so `null` and
/// non-object branches are skipped), else `None`. Mirrors the desktop column
/// builder's `resolveObjectMember` EXACTLY — first-object-member-wins, and the
/// `type: "object"` requirement is deliberate: a branch carrying `properties` but no
/// explicit `type: "object"`, or a second object branch, is ignored so the validator
/// and the desktop grid agree on which subfields exist.
fn resolve_nullable_object_member(node: &serde_json::Value) -> Option<&serde_json::Value> {
    for union_key in ["anyOf", "oneOf"] {
        if let Some(branches) = node.get(union_key).and_then(|value| value.as_array()) {
            for member in branches {
                let member_is_object_type =
                    member.get("type").and_then(|value| value.as_str()) == Some("object");
                let member_has_properties_object = member
                    .get("properties")
                    .map(|value| value.is_object())
                    .unwrap_or(false);
                if member_is_object_type && member_has_properties_object {
                    return Some(member);
                }
            }
        }
    }
    None
}

/// Walks a JSON-Schema `properties` map and collects every property node at every
/// depth, paired with its path segments from the schema root. Descends into a node's
/// DIRECT object `properties`, and — when a node has none — into the non-null object
/// member of an `anyOf`/`oneOf` nullable-object union (see
/// `resolve_nullable_object_member`), so a subfield inside the Shopify-style
/// `anyOf: [{type:object, properties:{…}}, {type:null}]` shape is collected exactly
/// as the desktop grid locks it (DEV-10494). Array `items` / `$ref` are still not
/// walked (no static property name to annotate). Yields the parent object node too,
/// preserving the pre-existing behaviour where a top-level object can itself be
/// annotated.
///
/// Path *segments* are carried (a `Vec<String>`), not a pre-joined dotted string,
/// so callers navigate values by the exact keys and only join for display.
fn collect_schema_properties<'a>(
    properties: &'a serde_json::Map<String, serde_json::Value>,
    prefix: &[String],
    depth_budget: usize,
    out: &mut Vec<(Vec<String>, &'a serde_json::Value)>,
) {
    for (field_name, node) in properties {
        let mut path = prefix.to_vec();
        path.push(field_name.clone());
        out.push((path.clone(), node));
        if depth_budget > 0 {
            // Direct object `properties` win; only when a node has none do we descend
            // into a nullable-object union member's `properties` — mirroring desktop's
            // directContainer-before-unionMember ordering in `walkProperties`. The
            // union recursion shares the same decremented `depth_budget`, so a chain
            // of unions is still bounded by MAX_SCHEMA_PROPERTY_RECURSION_DEPTH.
            let child_properties = node
                .get("properties")
                .and_then(|value| value.as_object())
                .or_else(|| {
                    resolve_nullable_object_member(node)
                        .and_then(|member| member.get("properties"))
                        .and_then(|value| value.as_object())
                });
            if let Some(child_properties) = child_properties {
                collect_schema_properties(child_properties, &path, depth_budget - 1, out);
            }
        }
    }
}

/// Follows `path` segment-by-segment through nested JSON objects. Returns `None`
/// if any intermediate segment is absent or not an object — mirroring a
/// `record.get(name)` miss for a top-level field. An empty path returns the value
/// itself (unused in practice; collected paths always have at least one segment).
fn get_by_segments<'a>(
    value: &'a serde_json::Value,
    path: &[String],
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(segment.as_str())?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── enforce_schema tests ──────────────────────────────────────────────────

    fn schema_with_required(required: &[&str]) -> serde_json::Value {
        json!({ "schema": { "required": required, "properties": {} } })
    }

    fn schema_with_readonly(fields: &[&str]) -> serde_json::Value {
        let mut props = serde_json::Map::new();
        for f in fields {
            props.insert(f.to_string(), json!({ "x-scratch-readonly": true }));
        }
        json!({ "schema": { "required": [], "properties": props } })
    }

    fn schema_with_write_once(fields: &[&str]) -> serde_json::Value {
        let mut props = serde_json::Map::new();
        for f in fields {
            props.insert(f.to_string(), json!({ "x-scratch-write-once": true }));
        }
        json!({ "schema": { "required": [], "properties": props } })
    }

    /// Schema where `id` is the primary key (idPath) and also required.
    /// Uses the new `idPath` field name (DEV-10092); the Attio fixture below
    /// keeps the legacy `idColumnRemoteId` to cover backward compat.
    fn schema_with_id_column() -> serde_json::Value {
        json!({
            "idPath": "id",
            "schema": {
                "required": ["id", "name"],
                "properties": {
                    "id": { "type": "number" },
                    "name": { "type": "string" }
                }
            }
        })
    }

    fn record_ctx(
        record: serde_json::Value,
        master: Option<serde_json::Value>,
        schema: serde_json::Value,
    ) -> RecordValidationContext {
        RecordValidationContext {
            filename: "rec-001.json".to_string(),
            record,
            master_record: master,
            schema,
            args: json!({}),
        }
    }

    #[test]
    fn required_field_missing_is_error() {
        let ctx = record_ctx(
            json!({"name": "Alice"}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Error);
        assert!(results[0].message.as_deref().unwrap().contains("required"));
    }

    #[test]
    fn required_field_null_is_error() {
        let ctx = record_ctx(
            json!({"id": null, "name": "Alice"}),
            None,
            schema_with_required(&["id"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn required_field_empty_string_is_error() {
        let ctx = record_ctx(
            json!({"id": 1, "name": ""}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "name");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn all_required_fields_present_is_clean() {
        let ctx = record_ctx(
            json!({"id": 1, "name": "Alice"}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn empty_string_in_nullable_formatted_field_is_clean() {
        // Connectors (e.g. Moco) return "" for an unset email; it is neither a valid
        // email nor null, but a blank value is verbatim "no value" and must not be
        // flagged for failing the format/anyOf conformance check (DEV-10453).
        let schema = json!({ "schema": { "properties": {
            "email": { "anyOf": [ { "type": "string", "format": "email" }, { "type": "null" } ] }
        }}});
        let ctx = record_ctx(json!({ "email": "" }), None, schema);
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "blank formatted field should be clean, got {} error(s)",
            results.len()
        );
    }

    #[test]
    fn empty_string_in_direct_formatted_field_is_clean() {
        // Same exemption for a non-nullable formatted field (Format error, not AnyOf).
        let schema = json!({ "schema": { "properties": {
            "email": { "type": "string", "format": "email" }
        }}});
        let ctx = record_ctx(json!({ "email": "" }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn nonempty_invalid_nullable_formatted_field_is_warning() {
        // Only "" is exempt — a non-empty malformed value is still flagged, but as a
        // WARNING: the service stores the value verbatim and doesn't enforce `format`, so
        // a format mismatch is informational, not a hard error. The failure surfaces as a
        // single `AnyOf` error (the string branch fails only on `format`, the null branch
        // on `type`), which the purely-format-caused check reclassifies to a warning.
        let schema = json!({ "schema": { "properties": {
            "email": { "anyOf": [ { "type": "string", "format": "email" }, { "type": "null" } ] }
        }}});
        let ctx = record_ctx(json!({ "email": "not-an-email" }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "email");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        // The crate's raw message for the nullable case is the opaque "… is not valid under
        // any of the schemas listed in the 'anyOf' keyword"; we replace it with a readable
        // one naming the value and the format.
        assert_eq!(
            results[0].message.as_deref(),
            Some("\"not-an-email\" is not a valid email")
        );
    }

    #[test]
    fn nonempty_invalid_direct_formatted_field_is_warning() {
        // A non-nullable formatted field surfaces a direct `Format` error (not `AnyOf`);
        // it is reclassified to a warning for the same reason and gets the same readable
        // message.
        let schema = json!({ "schema": { "properties": {
            "email": { "type": "string", "format": "email" }
        }}});
        let ctx = record_ctx(json!({ "email": "not-an-email" }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "email");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("\"not-an-email\" is not a valid email")
        );
    }

    #[test]
    fn invalid_value_in_dual_format_union_is_warning() {
        // Notion dates: `anyOf[{string, format:date}, {string, format:date-time}]`. Both
        // branches fail ONLY on `format`, so the union failure is purely format-caused and
        // the message names both formats.
        let schema = json!({ "schema": { "properties": {
            "due": { "anyOf": [
                { "type": "string", "format": "date" },
                { "type": "string", "format": "date-time" }
            ] }
        }}});
        let ctx = record_ctx(json!({ "due": "not-a-date" }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "due");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("\"not-a-date\" is not a valid date or date-time")
        );
    }

    #[test]
    fn invalid_format_nested_in_object_branch_is_warning() {
        // Notion icon/cover shape: a union of objects, one of which holds a formatted url.
        // A bad url inside the matching object branch fails only on `format`, so the union
        // failure is purely format-caused and reclassified to a warning. The message names
        // the offending LEAF value (the bad url), not the whole container.
        let schema = json!({ "schema": { "properties": {
            "icon": { "anyOf": [
                { "type": "object", "properties": {
                    "type": { "const": "external" },
                    "external": { "type": "object", "properties": {
                        "url": { "type": "string", "format": "uri" }
                    }}
                }},
                { "type": "null" }
            ] }
        }}});
        let ctx = record_ctx(
            json!({ "icon": { "type": "external", "external": { "url": "not a url" } } }),
            None,
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "icon");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("\"not a url\" is not a valid uri")
        );
    }

    #[test]
    fn wrong_type_in_nullable_formatted_field_still_errors() {
        // A number in a `string|null` field is a genuine structural failure: every branch
        // fails on `type` (format never applies to a non-string), so no branch is
        // all-format ⇒ stays an error.
        let schema = json!({ "schema": { "properties": {
            "email": { "anyOf": [ { "type": "string", "format": "email" }, { "type": "null" } ] }
        }}});
        let ctx = record_ctx(json!({ "email": 42 }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "email");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    // ── DEV-10540: blanks nested inside an anyOf-wrapped container ────────────

    /// WordPress `acf` shape: `anyOf[ object{ number_field: number|null }, array(maxItems:0) ]`.
    /// `extra_object_properties` are merged into the object branch's `properties`.
    fn schema_anyof_wrapped_acf(extra_object_properties: serde_json::Value) -> serde_json::Value {
        let mut object_branch_properties = json!({
            "number_field": { "anyOf": [{ "type": "number" }, { "type": "null" }] }
        });
        if let (Some(target), Some(extra)) = (
            object_branch_properties.as_object_mut(),
            extra_object_properties.as_object(),
        ) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        json!({ "schema": { "properties": {
            "acf": { "anyOf": [
                { "type": "object", "properties": object_branch_properties },
                { "type": "array", "maxItems": 0 }
            ]}
        }}})
    }

    #[test]
    fn nested_blank_empty_string_in_anyof_container_is_clean() {
        // An empty ACF number field comes back as "" inside the anyOf-wrapped object;
        // it must not surface (DEV-10540).
        let ctx = record_ctx(
            json!({ "acf": { "number_field": "" } }),
            None,
            schema_anyof_wrapped_acf(json!({})),
        );
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "blank nested field should be clean, got {} error(s)",
            results.len()
        );
    }

    #[test]
    fn nested_blank_null_in_anyof_container_is_clean() {
        // A nested `null` blank inside an anyOf-wrapped object. The field is typed
        // non-nullable `number` so the `null` actually fails the object branch and the
        // failure bubbles to the `acf` container — exercising the nested-blank path.
        let schema = json!({ "schema": { "properties": {
            "acf": { "anyOf": [
                { "type": "object", "properties": { "number_field": { "type": "number" } } },
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(json!({ "acf": { "number_field": null } }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn nested_wrong_type_in_anyof_container_still_errors() {
        // A genuinely-wrong nested value (non-blank string where a number is required)
        // must still surface.
        let schema = json!({ "schema": { "properties": {
            "acf": { "anyOf": [
                { "type": "object", "properties": { "number_field": { "type": "number" } } },
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "acf": { "number_field": "not-a-number" } }),
            None,
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "acf");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn nested_blank_beside_wrong_value_still_errors() {
        // One blank ("") and one genuinely-wrong value in the SAME container: the blank
        // is stripped but the bad sibling survives re-validation, so the error stays.
        let ctx = record_ctx(
            json!({ "acf": { "number_field": "", "other_number": "wrong" } }),
            None,
            schema_anyof_wrapped_acf(json!({ "other_number": { "type": "number" } })),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            1,
            "blank must not mask the sibling bad value, got {} error(s)",
            results.len()
        );
        assert_eq!(results[0].field_path, "acf");
    }

    #[test]
    fn empty_array_branch_with_actual_empty_array_is_clean() {
        // WordPress returns `acf: []` (PHP empty associative array); it matches the
        // `maxItems: 0` branch directly and is clean.
        let ctx = record_ctx(
            json!({ "acf": [] }),
            None,
            schema_anyof_wrapped_acf(json!({})),
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn deeply_nested_blank_in_anyof_container_is_clean() {
        // A blank two levels down inside the wrapped object; recursion + format parity.
        let schema = json!({ "schema": { "properties": {
            "acf": { "anyOf": [
                { "type": "object", "properties": {
                    "image": { "type": "object", "properties": {
                        "url": { "type": "string", "format": "uri" }
                    }}
                }},
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(json!({ "acf": { "image": { "url": "" } } }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn blank_inside_array_element_object_is_clean() {
        // An anyOf-wrapped array of objects whose only element holds a blank leaf.
        let schema = json!({ "schema": { "properties": {
            "gallery": { "anyOf": [
                { "type": "array", "items": { "type": "object", "properties": {
                    "caption": { "type": "string", "format": "uri" }
                }}},
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(json!({ "gallery": [ { "caption": "" } ] }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn blank_and_bad_in_separate_array_elements_still_errors() {
        // `[{n:""}, {n:"bad"}]` — element 0's blank is stripped, element 1's bad value
        // survives, so the container error still surfaces.
        let schema = json!({ "schema": { "properties": {
            "items_field": { "anyOf": [
                { "type": "array", "items": { "type": "object", "properties": {
                    "n": { "anyOf": [{ "type": "number" }, { "type": "null" }] }
                }}},
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "items_field": [ { "n": "" }, { "n": "bad" } ] }),
            None,
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            1,
            "bad sibling array element must surface, got {} error(s)",
            results.len()
        );
    }

    #[test]
    fn required_nested_field_blank_in_anyof_container_still_errors() {
        // If the nested field is REQUIRED inside the branch, stripping the blank makes
        // the branch fail `required`, the anyOf re-fails, and the error surfaces. This
        // is the documented conservative behaviour (safe, never masks; no worse than
        // before this change).
        let schema = json!({ "schema": { "properties": {
            "acf": { "anyOf": [
                { "type": "object",
                  "required": ["number_field"],
                  "properties": { "number_field": { "type": "number" } } },
                { "type": "array", "maxItems": 0 }
            ]}
        }}});
        let ctx = record_ctx(json!({ "acf": { "number_field": "" } }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            1,
            "required-but-blank nested field must surface, got {} error(s)",
            results.len()
        );
    }

    #[test]
    fn flat_top_level_blank_still_clean_after_nested_change() {
        // Regression guard: the original top-level "" / null leaf skips still fire and
        // the new container guard does not change flat-field behaviour.
        let schema = json!({ "schema": { "properties": {
            "email": { "anyOf": [{ "type": "string", "format": "email" }, { "type": "null" }] }
        }}});
        assert!(
            enforce_schema(&record_ctx(json!({ "email": "" }), None, schema.clone())).is_empty()
        );
        assert!(enforce_schema(&record_ctx(json!({ "email": null }), None, schema)).is_empty());
    }

    // ── nullable-aware required check (Fix 1) ─────────────────────────────────

    /// `field` is required AND nullable (anyOf wrapper) — the Intercom shape.
    fn schema_required_nullable(field: &str) -> serde_json::Value {
        json!({ "schema": {
            "required": [field],
            "properties": { field: { "anyOf": [{ "type": "string" }, { "type": "null" }] } }
        }})
    }

    /// `field` is required and NON-nullable.
    fn schema_required_non_nullable(field: &str) -> serde_json::Value {
        json!({ "schema": {
            "required": [field],
            "properties": { field: { "type": "string" } }
        }})
    }

    #[test]
    fn required_null_on_nullable_field_is_clean() {
        // Intercom's `team_assignee_id: anyOf[string, null]` is required, but the
        // verbatim value is null — a legitimate value, not missing.
        let ctx = record_ctx(json!({ "x": null }), None, schema_required_nullable("x"));
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn required_empty_string_on_nullable_field_is_clean() {
        // Intercom's `title` is anyOf[string, null]; the verbatim value is "".
        let ctx = record_ctx(json!({ "x": "" }), None, schema_required_nullable("x"));
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn required_null_on_non_nullable_field_still_errors() {
        let ctx = record_ctx(
            json!({ "x": null }),
            None,
            schema_required_non_nullable("x"),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "x");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn required_empty_string_on_non_nullable_field_still_errors() {
        let ctx = record_ctx(json!({ "x": "" }), None, schema_required_non_nullable("x"));
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "x");
    }

    #[test]
    fn required_absent_key_on_nullable_field_still_errors() {
        // Nullable permits a present null, but an absent key still violates required.
        let ctx = record_ctx(json!({}), None, schema_required_nullable("x"));
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "x");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn required_nullable_via_type_array_is_clean() {
        let schema = json!({ "schema": {
            "required": ["x"],
            "properties": { "x": { "type": ["string", "null"] } }
        }});
        let ctx = record_ctx(json!({ "x": null }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn required_nullable_via_oneof_is_clean() {
        let schema = json!({ "schema": {
            "required": ["x"],
            "properties": { "x": { "oneOf": [{ "type": "number" }, { "type": "null" }] } }
        }});
        let ctx = record_ctx(json!({ "x": null }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn intercom_shaped_nullable_required_record_is_clean() {
        // Mirrors a real Conversations record: nullable-but-required fields are
        // present-but-null/blank. None should be flagged (the 88,662-error fix).
        let schema = json!({ "schema": {
            "required": ["title", "team_assignee_id", "conversation_rating"],
            "properties": {
                "title": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                "team_assignee_id": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                "conversation_rating": { "anyOf": [{ "type": "object" }, { "type": "null" }] }
            }
        }});
        let ctx = record_ctx(
            json!({ "title": "", "team_assignee_id": null, "conversation_rating": null }),
            None,
            schema,
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn schema_property_permits_null_detects_nullable_forms() {
        assert!(schema_property_permits_null(&json!({ "type": "null" })));
        assert!(schema_property_permits_null(
            &json!({ "type": ["string", "null"] })
        ));
        assert!(schema_property_permits_null(
            &json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] })
        ));
        assert!(schema_property_permits_null(
            &json!({ "oneOf": [{ "type": "number" }, { "type": "null" }] })
        ));
        assert!(!schema_property_permits_null(&json!({ "type": "string" })));
        assert!(!schema_property_permits_null(
            &json!({ "anyOf": [{ "type": "string" }, { "type": "number" }] })
        ));
        assert!(!schema_property_permits_null(&json!({})));
        assert!(!schema_property_permits_null(&json!("x")));
    }

    // ── null conformance skip (Fix 3) ─────────────────────────────────────────

    #[test]
    fn null_conformance_error_on_non_required_field_is_skipped() {
        // Webflow returns null for an unset optional field the schema types as a
        // non-nullable string. It is not required, so it must be clean.
        let schema = json!({ "schema": { "properties": {
            "summary": { "type": "string" }
        }}});
        let ctx = record_ctx(json!({ "summary": null }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn null_conformance_error_for_array_field_is_skipped() {
        let schema = json!({ "schema": { "properties": {
            "categories": { "type": "array", "items": { "type": "string" } }
        }}});
        let ctx = record_ctx(json!({ "categories": null }), None, schema);
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn null_on_non_nullable_required_field_still_errors_once() {
        // The conformance error is skipped, but the required check still flags the
        // null (non-nullable + required): exactly one error, from the required check.
        let schema = json!({ "schema": {
            "required": ["name"],
            "properties": { "name": { "type": "string" } }
        }});
        let ctx = record_ctx(json!({ "name": null }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "name");
        assert!(results[0].message.as_deref().unwrap().contains("required"));
    }

    #[test]
    fn date_only_and_date_time_both_validate_against_notion_date_union() {
        // The Notion connector models a date property's inner `start`/`end` as a
        // `date | date-time` string union, because Notion emits all-day dates as
        // date-only ("2025-02-20") and timed dates as full RFC3339. Both precisions
        // must validate under should_validate_formats(true). Regression lock for the
        // Notion date-only schema fix (a date-time-only schema flagged every all-day date).
        let date_string = json!({ "anyOf": [
            { "type": "string", "format": "date" },
            { "type": "string", "format": "date-time" }
        ]});
        let schema = json!({ "schema": { "properties": {
            "when": { "type": "object", "properties": {
                "start": date_string.clone(),
                "end": { "anyOf": [ date_string, { "type": "null" } ] }
            }}
        }}});

        let date_only = record_ctx(
            json!({ "when": { "start": "2025-02-20", "end": null } }),
            None,
            schema.clone(),
        );
        let date_only_results = enforce_schema(&date_only);
        assert!(
            date_only_results.is_empty(),
            "date-only start should validate, got {} error(s)",
            date_only_results.len()
        );

        let date_time = record_ctx(
            json!({ "when": { "start": "2025-02-20T13:00:00.000Z", "end": null } }),
            None,
            schema,
        );
        assert!(enforce_schema(&date_time).is_empty());
    }

    #[test]
    fn local_date_time_format_asserts_nothing() {
        // `date-time-local` is Scratch's token for a wall-clock timestamp serialized
        // WITHOUT a UTC offset — what WordPress returns for `date`/`modified`
        // ("2026-07-28T20:20:00"). It exists so the export layer can tell that such a
        // value is time-bearing (and build a real timestamp column on the destination)
        // WITHOUT the validator asserting RFC 3339, which the value would fail on every
        // record. That only works because the crate ignores a `format` it doesn't know,
        // even under should_validate_formats(true) — lock it (DEV-11091).
        let schema = json!({ "schema": { "properties": {
            "date": { "anyOf": [
                { "type": "string", "format": "date-time-local" },
                { "type": "null" }
            ]}
        }}});

        for value in [
            json!("2026-07-28T20:20:00"), // WordPress's zoneless local time
            json!("2026-07-28T20:20:00Z"),
            json!(null),
            json!("not-a-date-at-all"), // asserts NOTHING — deliberately, see above
        ] {
            let ctx = record_ctx(json!({ "date": value.clone() }), None, schema.clone());
            let results = enforce_schema(&ctx);
            assert!(
                results.is_empty(),
                "date-time-local must not assert on {value:?}, got {} error(s)",
                results.len()
            );
        }

        // Contrast: the standard RFC 3339 keyword DOES flag the same zoneless value —
        // which is exactly why the WordPress schema can't use it.
        let rfc3339_schema = json!({ "schema": { "properties": {
            "date": { "type": "string", "format": "date-time" }
        }}});
        let ctx = record_ctx(
            json!({ "date": "2026-07-28T20:20:00" }),
            None,
            rfc3339_schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1, "expected exactly one date-time complaint");
        assert_eq!(results[0].level, ValidationLevel::Warning);
    }

    #[test]
    fn non_date_string_warns_against_notion_date_union() {
        // The union still asserts formats — a non-empty, non-date string is flagged,
        // proving the date-only fix did not silently disable date validation. It surfaces
        // as a WARNING, not an error: the service stores the value verbatim and doesn't
        // enforce the date format, so the mismatch is informational.
        let schema = json!({ "schema": { "properties": {
            "when": { "type": "object", "properties": { "start": { "anyOf": [
                { "type": "string", "format": "date" },
                { "type": "string", "format": "date-time" }
            ]}}}
        }}});
        let ctx = record_ctx(json!({ "when": { "start": "not-a-date" } }), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            1,
            "non-date should produce exactly one violation, got {}",
            results.len()
        );
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("\"not-a-date\" is not a valid date or date-time")
        );
    }

    #[test]
    fn schemeless_urls_validate_against_uri_format() {
        // Many connectors map a "link/website/url" service field to `format: "uri"`,
        // and those services return SCHEMELESS host strings verbatim — e.g. Webflow's
        // CMS Link field stores `usecaucus.com` / `www.arcadia.solutions` as typed.
        // Per "preserve external data fidelity" the schema must accept what the service
        // returns, so a schemeless host-shaped string validates as a `uri`. These are
        // the exact verbatim values that surfaced as prod `enforce_schema` noise.
        let schema = json!({ "schema": { "properties": {
            "website": { "anyOf": [ { "type": "string", "format": "uri" }, { "type": "null" } ] }
        }}});
        for legitimate_value in [
            "usecaucus.com",
            "www.arcadia.solutions",
            "foo.io/path?q=1",
            "https://www.linkedin.com/posts/abc?utm_source=share",
            "http://example.com",
        ] {
            let ctx = record_ctx(json!({ "website": legitimate_value }), None, schema.clone());
            let results = enforce_schema(&ctx);
            assert!(
                results.is_empty(),
                "{legitimate_value:?} should validate as a uri, got {} error(s)",
                results.len()
            );
        }
    }

    #[test]
    fn malformed_urls_warn_against_uri_format() {
        // Widening `uri` to accept schemeless hosts must NOT collapse to "any non-empty
        // string" — genuine garbage must keep surfacing ("surface failures; never
        // silently succeed"). The embedded-`…` value is a real truncated-URL shape seen
        // in prod Webflow Testimonials records; a bare word and a value with whitespace
        // are obviously not URIs. The violation surfaces as a WARNING, not an error: the
        // service stores the value verbatim and doesn't enforce the uri format.
        let schema = json!({ "schema": { "properties": {
            "website": { "anyOf": [ { "type": "string", "format": "uri" }, { "type": "null" } ] }
        }}});
        for malformed_value in [
            "https://www.linkedin.com/posts/marshwah_act[…]557015867392-hr-a",
            "not a url",
            "singlelabel",
            "hello world",
        ] {
            let ctx = record_ctx(json!({ "website": malformed_value }), None, schema.clone());
            let results = enforce_schema(&ctx);
            assert_eq!(
                results.len(),
                1,
                "{malformed_value:?} should fail uri validation, got {} violation(s)",
                results.len()
            );
            assert_eq!(results[0].level, ValidationLevel::Warning);
            // Readable message naming the value and the failed format.
            let message = results[0].message.as_deref().unwrap_or_default();
            assert!(
                message.ends_with(" is not a valid uri"),
                "unexpected message for {malformed_value:?}: {message:?}"
            );
        }
    }

    #[test]
    fn id_column_required_skipped_for_new_record() {
        // New record (master=None): id not yet assigned by remote — no required error.
        let ctx = record_ctx(json!({"name": "Alice"}), None, schema_with_id_column());
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "id column should not error on new records"
        );
    }

    /// Mirrors Attio: `idColumnRemoteId` is a dot path into the id triple, but
    /// the JSON Schema's `required` only lists the top-level `id` object. The
    /// validator must compare against the path's first segment.
    fn schema_with_dot_path_id_column() -> serde_json::Value {
        json!({
            "idColumnRemoteId": "id.record_id",
            "schema": {
                "required": ["id", "values"],
                "properties": {
                    "id": {
                        "type": "object",
                        "properties": {
                            "workspace_id": { "type": "string" },
                            "object_id": { "type": "string" },
                            "record_id": { "type": "string" }
                        }
                    },
                    "values": { "type": "object" }
                }
            }
        })
    }

    #[test]
    fn id_column_dot_path_skipped_for_new_record() {
        // New Attio-shaped record: no `id` triple yet (the connector hasn't
        // assigned one). The required check on the top-level `id` must be
        // skipped because `idColumnRemoteId` points into it.
        let ctx = record_ctx(
            json!({"values": {}}),
            None,
            schema_with_dot_path_id_column(),
        );
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "id triple should not error on new records when idColumnRemoteId is a dot path; got {} violations",
            results.len()
        );
    }

    #[test]
    fn id_column_required_enforced_for_existing_record() {
        // Existing record (master=Some): id is required and must be present.
        let ctx = record_ctx(
            json!({"name": "Alice"}),
            Some(json!({"id": 1, "name": "Alice"})),
            schema_with_id_column(),
        );
        let results = enforce_schema(&ctx);
        let required_error = results
            .iter()
            .find(|r| r.field_path == "id" && r.level == ValidationLevel::Error);
        assert!(
            required_error.is_some(),
            "expected a required error for 'id'"
        );
    }

    #[test]
    fn readonly_field_changed_is_warning() {
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 99}), Some(json!({"id": 1})), schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated read-only field")
        );
        assert_eq!(
            results[0].description.as_deref(),
            Some(
                "Field id changed from 1 to 99. The new value may cause an error when publishing."
            )
        );
    }

    #[test]
    fn readonly_field_unchanged_is_clean() {
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 1}), Some(json!({"id": 1})), schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_field_set_on_new_record_is_warning() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({"ts": "2024-01-01"}), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "ts");
        assert_eq!(results[0].level, ValidationLevel::Warning);
    }

    #[test]
    fn readonly_field_absent_on_new_record_is_clean() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({}), None, schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_field_null_on_new_record_is_clean() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({"ts": null}), None, schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_master_missing_field_no_violation() {
        // Master doesn't have the field at all — no baseline, no violation.
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 1}), Some(json!({})), schema);
        let results = enforce_schema(&ctx);
        // working = Some(1), master = None → they differ → warning
        // (spec says "field didn't exist before" is not a violation, but our
        // implementation treats None != Some(1) as a change from master.
        // This test documents current behaviour.)
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
    }

    // ── write-once tests ──────────────────────────────────────────────────────

    #[test]
    fn write_once_changed_on_existing_is_warning() {
        // Existing record (master present): changing a write-once field warns.
        let schema = schema_with_write_once(&["parent_object"]);
        let ctx = record_ctx(
            json!({"parent_object": "people"}),
            Some(json!({"parent_object": "companies"})),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "parent_object");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated write-once field")
        );
    }

    #[test]
    fn write_once_unchanged_on_existing_is_clean() {
        let schema = schema_with_write_once(&["parent_object"]);
        let ctx = record_ctx(
            json!({"parent_object": "companies"}),
            Some(json!({"parent_object": "companies"})),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn write_once_set_on_new_record_is_clean() {
        // The key divergence from read-only: setting a write-once field on a NEW
        // record (no master) is exactly how it's meant to be used — no warning.
        let schema = schema_with_write_once(&["parent_object"]);
        let ctx = record_ctx(json!({"parent_object": "companies"}), None, schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    // ── nested write-once / readonly recursion (DEV-10437) ────────────────────

    /// Top-level `location` object whose `lat` subfield is write-once.
    fn schema_nested_write_once_lat() -> serde_json::Value {
        json!({ "schema": { "properties": {
            "location": { "type": "object", "properties": {
                "address": { "type": "string" },
                "lat": { "type": "number", "x-scratch-write-once": true }
            }}
        }}})
    }

    /// Top-level `location` object whose `lat` subfield is read-only.
    fn schema_nested_readonly_lat() -> serde_json::Value {
        json!({ "schema": { "properties": {
            "location": { "type": "object", "properties": {
                "lat": { "type": "number", "x-scratch-readonly": true }
            }}
        }}})
    }

    #[test]
    fn nested_write_once_changed_on_existing_is_warning() {
        // Changing a nested write-once subfield on an existing record warns, with
        // the full dot-path. This is the core DEV-10437 fix.
        let ctx = record_ctx(
            json!({ "location": { "lat": 2 } }),
            Some(json!({ "location": { "lat": 1 } })),
            schema_nested_write_once_lat(),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "location.lat");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated write-once field")
        );
    }

    #[test]
    fn nested_write_once_unchanged_on_existing_is_clean() {
        let ctx = record_ctx(
            json!({ "location": { "lat": 1 } }),
            Some(json!({ "location": { "lat": 1 } })),
            schema_nested_write_once_lat(),
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn nested_write_once_set_on_new_record_is_clean() {
        // New record (no master): setting a nested write-once value is how it's
        // meant to be used — no warning.
        let ctx = record_ctx(
            json!({ "location": { "lat": 1 } }),
            None,
            schema_nested_write_once_lat(),
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn nested_readonly_changed_on_existing_is_warning() {
        let ctx = record_ctx(
            json!({ "location": { "lat": 2 } }),
            Some(json!({ "location": { "lat": 1 } })),
            schema_nested_readonly_lat(),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "location.lat");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated read-only field")
        );
    }

    #[test]
    fn nested_readonly_set_on_new_record_is_warning() {
        let ctx = record_ctx(
            json!({ "location": { "lat": 5 } }),
            None,
            schema_nested_readonly_lat(),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "location.lat");
        assert_eq!(results[0].level, ValidationLevel::Warning);
    }

    #[test]
    fn deeply_nested_write_once_changed_is_warning() {
        // Two levels deep (`a.b.c`) proves true recursion, not one-level special-casing.
        let schema = json!({ "schema": { "properties": {
            "a": { "type": "object", "properties": {
                "b": { "type": "object", "properties": {
                    "c": { "type": "string", "x-scratch-write-once": true }
                }}
            }}
        }}});
        let ctx = record_ctx(
            json!({ "a": { "b": { "c": "new" } } }),
            Some(json!({ "a": { "b": { "c": "old" } } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "a.b.c");
        assert_eq!(results[0].level, ValidationLevel::Warning);
    }

    #[test]
    fn nested_change_does_not_flag_unannotated_sibling_or_parent() {
        // Only the annotated leaf warns; the unannotated `address` sibling and the
        // unannotated `location` parent (both also changed) stay clean.
        let ctx = record_ctx(
            json!({ "location": { "address": "B St", "lat": 2 } }),
            Some(json!({ "location": { "address": "A St", "lat": 1 } })),
            schema_nested_write_once_lat(),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "location.lat");
    }

    #[test]
    fn write_once_inside_array_items_is_not_enforced() {
        // Scope boundary: array `items` are NOT walked (no element-index path), so
        // a write-once annotation on an array element subfield produces no warning.
        // Locks the boundary so adding array support later is a deliberate change.
        let schema = json!({ "schema": { "properties": {
            "tags": { "type": "array", "items": { "type": "object", "properties": {
                "id": { "type": "string", "x-scratch-write-once": true }
            }}}
        }}});
        let ctx = record_ctx(
            json!({ "tags": [{ "id": "new" }] }),
            Some(json!({ "tags": [{ "id": "old" }] })),
            schema,
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    // ── DEV-10494: anyOf/oneOf nullable-object recursion ──────────────────────

    #[test]
    fn write_once_inside_nullable_anyof_object_is_enforced() {
        // DEV-10494: subfields inside an `anyOf` nullable-object union ARE walked, so
        // a write-once annotation on `seo.title` warns when it changes on an existing
        // record — matching the desktop grid, which locks the same cell.
        let schema = json!({ "schema": { "properties": {
            "seo": { "anyOf": [
                { "type": "object", "properties": {
                    "title": { "type": "string", "x-scratch-write-once": true }
                }},
                { "type": "null" }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "seo": { "title": "new" } }),
            Some(json!({ "seo": { "title": "old" } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "seo.title");
        assert_eq!(results[0].field_path_segments, vec!["seo", "title"]);
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated write-once field")
        );
    }

    #[test]
    fn readonly_inside_nullable_oneof_object_is_enforced() {
        // Companion to the write-once case (DEV-10494): a readonly subfield inside a
        // `oneOf` nullable-object union also warns when changed on an existing record.
        // Uses `oneOf` (not `anyOf`) to cover both union keywords.
        let schema = json!({ "schema": { "properties": {
            "seo": { "oneOf": [
                { "type": "object", "properties": {
                    "title": { "type": "string", "x-scratch-readonly": true }
                }},
                { "type": "null" }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "seo": { "title": "new" } }),
            Some(json!({ "seo": { "title": "old" } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "seo.title");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated read-only field")
        );
    }

    #[test]
    fn anyof_object_branch_without_type_keyword_is_not_walked() {
        // Desktop parity (DEV-10494): `resolveObjectMember` requires the member to
        // carry `type: "object"`. A union branch with `properties` but NO explicit
        // `type` is not a recognised object member, so its subfields stay unenforced —
        // matching the grid exactly (no over-eager recursion).
        let schema = json!({ "schema": { "properties": {
            "seo": { "anyOf": [
                { "properties": {
                    "title": { "type": "string", "x-scratch-write-once": true }
                }},
                { "type": "null" }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "seo": { "title": "new" } }),
            Some(json!({ "seo": { "title": "old" } })),
            schema,
        );
        assert!(enforce_schema(&ctx).is_empty());
    }

    #[test]
    fn anyof_uses_first_object_member_like_desktop() {
        // Desktop parity (DEV-10494): the FIRST `type:"object"` member with
        // `properties` wins; a second object branch is ignored. So the annotation on
        // the first branch's subfield is enforced and the second branch's is not.
        let schema = json!({ "schema": { "properties": {
            "seo": { "anyOf": [
                { "type": "object", "properties": {
                    "first": { "type": "string", "x-scratch-readonly": true }
                }},
                { "type": "object", "properties": {
                    "second": { "type": "string", "x-scratch-readonly": true }
                }}
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "seo": { "first": "B", "second": "B" } }),
            Some(json!({ "seo": { "first": "A", "second": "A" } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "seo.first");
    }

    #[test]
    fn nested_anyof_union_recursion_reaches_deeper_leaf() {
        // The union recursion shares the depth budget with direct-properties recursion,
        // so a union nested inside a direct object still reaches its leaf with the full
        // dot-path.
        let schema = json!({ "schema": { "properties": {
            "outer": { "type": "object", "properties": {
                "seo": { "anyOf": [
                    { "type": "object", "properties": {
                        "title": { "type": "string", "x-scratch-write-once": true }
                    }},
                    { "type": "null" }
                ]}
            }}
        }}});
        let ctx = record_ctx(
            json!({ "outer": { "seo": { "title": "new" } } }),
            Some(json!({ "outer": { "seo": { "title": "old" } } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "outer.seo.title");
        assert_eq!(
            results[0].field_path_segments,
            vec!["outer", "seo", "title"]
        );
    }

    // ── DEV-10493 / DEV-10495: severity-aware, segment-keyed dedup ─────────────

    #[test]
    fn jsonschema_error_beats_readonly_warning_at_same_nested_path() {
        // DEV-10493: a nested field that is BOTH readonly (Warning) AND fails
        // JSONSchema conformance (Error) at the same path keeps exactly one result —
        // the Error — instead of the old "last push wins" which kept the Warning and
        // silently dropped the Error. Relies on JSONSchema errors carrying real
        // segments (`["location","lat"]`) so they dedup against the readonly result.
        let schema = json!({ "schema": { "properties": {
            "location": { "type": "object", "properties": {
                "lat": { "type": "number", "x-scratch-readonly": true }
            }}
        }}});
        let ctx = record_ctx(
            json!({ "location": { "lat": "not-a-number" } }),
            Some(json!({ "location": { "lat": 1 } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            1,
            "Error and Warning at the same path must collapse to one: {:?}",
            results
                .iter()
                .map(|r| (r.field_path.clone(), r.level))
                .collect::<Vec<_>>()
        );
        assert_eq!(results[0].field_path, "location.lat");
        assert_eq!(
            results[0].level,
            ValidationLevel::Error,
            "the Error must win, not the readonly Warning"
        );
    }

    #[test]
    fn jsonschema_error_beats_readonly_warning_at_top_level() {
        // Top-level counterpart (DEV-10493): inverts the previous "hand-rolled readonly
        // message beats the JSONSchema error" behaviour for the Error-vs-Warning case.
        let schema = json!({ "schema": { "properties": {
            "score": { "type": "number", "x-scratch-readonly": true }
        }}});
        let ctx = record_ctx(
            json!({ "score": "not-a-number" }),
            Some(json!({ "score": 1 })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "score");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn equal_severity_dedup_keeps_last_pushed_message() {
        // DEV-10493 tie-break: on EQUAL severity the last-pushed result still wins, so
        // a field that is both readonly AND write-once (both Warning, write-once pushed
        // after readonly) keeps the write-once message — preserving the prior
        // last-wins-within-severity behaviour.
        let schema = json!({ "schema": { "properties": {
            "code": { "type": "string", "x-scratch-readonly": true, "x-scratch-write-once": true }
        }}});
        let ctx = record_ctx(
            json!({ "code": "new" }),
            Some(json!({ "code": "old" })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "code");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated write-once field")
        );
    }

    #[test]
    fn literal_dot_key_and_nested_path_both_survive_dedup() {
        // DEV-10495: a literal top-level key named "a.b" (segments ["a.b"]) and a
        // nested `a`→`b` (segments ["a","b"]) BOTH display as "a.b" but are distinct
        // identities, so both survive the in-memory dedup instead of one being lost.
        // NOTE: the persisted `validation_results` table keys on the display string,
        // so it still collapses these to one row — the dry-run path surfaces both.
        let schema = json!({ "schema": { "properties": {
            "a.b": { "type": "string", "x-scratch-readonly": true },
            "a": { "type": "object", "properties": {
                "b": { "type": "string", "x-scratch-readonly": true }
            }}
        }}});
        let ctx = record_ctx(
            json!({ "a.b": "new1", "a": { "b": "new2" } }),
            Some(json!({ "a.b": "old1", "a": { "b": "old2" } })),
            schema,
        );
        let results = enforce_schema(&ctx);
        assert_eq!(
            results.len(),
            2,
            "literal-dot key and nested path must both survive"
        );
        let segments: std::collections::HashSet<Vec<String>> = results
            .iter()
            .map(|r| r.field_path_segments.clone())
            .collect();
        assert!(segments.contains(&vec!["a.b".to_string()]));
        assert!(segments.contains(&vec!["a".to_string(), "b".to_string()]));
        // Both display identically — the ambiguity the persisted index can't tell apart.
        assert!(results.iter().all(|r| r.field_path == "a.b"));
    }

    #[test]
    fn compose_all_three_fixes_in_one_record() {
        // Integration proof that DEV-10493/10494/10495 compose: one record+schema that
        // exercises (a) Error-beats-Warning at a nested path, (b) literal-dot vs nested
        // both surviving, and (c) a write-once subfield inside an anyOf nullable object.
        let schema = json!({ "schema": { "properties": {
            "location": { "type": "object", "properties": {
                "lat": { "type": "number", "x-scratch-readonly": true }
            }},
            "x.y": { "type": "string", "x-scratch-readonly": true },
            "x": { "type": "object", "properties": {
                "y": { "type": "string", "x-scratch-readonly": true }
            }},
            "seo": { "anyOf": [
                { "type": "object", "properties": {
                    "title": { "type": "string", "x-scratch-write-once": true }
                }},
                { "type": "null" }
            ]}
        }}});
        let ctx = record_ctx(
            json!({ "location": { "lat": "nan" }, "x.y": "n1", "x": { "y": "n2" }, "seo": { "title": "new" } }),
            Some(
                json!({ "location": { "lat": 1 }, "x.y": "o1", "x": { "y": "o2" }, "seo": { "title": "old" } }),
            ),
            schema,
        );
        let results = enforce_schema(&ctx);
        let by_segments: std::collections::HashMap<Vec<String>, ValidationLevel> = results
            .iter()
            .map(|r| (r.field_path_segments.clone(), r.level))
            .collect();
        assert_eq!(
            results.len(),
            4,
            "got: {:?}",
            results
                .iter()
                .map(|r| (r.field_path.clone(), r.field_path_segments.clone(), r.level))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            by_segments.get(&vec!["location".to_string(), "lat".to_string()]),
            Some(&ValidationLevel::Error)
        );
        assert_eq!(
            by_segments.get(&vec!["x.y".to_string()]),
            Some(&ValidationLevel::Warning)
        );
        assert_eq!(
            by_segments.get(&vec!["x".to_string(), "y".to_string()]),
            Some(&ValidationLevel::Warning)
        );
        assert_eq!(
            by_segments.get(&vec!["seo".to_string(), "title".to_string()]),
            Some(&ValidationLevel::Warning)
        );
    }

    #[test]
    fn json_pointer_to_segments_decodes_rfc6901() {
        assert_eq!(json_pointer_to_segments(""), Vec::<String>::new());
        assert_eq!(
            json_pointer_to_segments("/location/lat"),
            vec!["location", "lat"]
        );
        // A literal dot in a key stays one segment (the DEV-10495 disambiguator).
        assert_eq!(json_pointer_to_segments("/a.b"), vec!["a.b"]);
        // `~1` → '/', `~0` → '~', applied in that RFC-6901 order (mixed key "a~/b").
        assert_eq!(json_pointer_to_segments("/a~1b"), vec!["a/b"]);
        assert_eq!(json_pointer_to_segments("/x~0y"), vec!["x~y"]);
        assert_eq!(json_pointer_to_segments("/a~0~1b"), vec!["a~/b"]);
    }

    #[test]
    fn collect_schema_properties_yields_parent_and_nested_paths() {
        let props = json!({
            "top": { "type": "string" },
            "location": { "type": "object", "properties": {
                "lat": { "type": "number" }
            }}
        });
        let map = props.as_object().unwrap();
        let mut out = Vec::new();
        collect_schema_properties(map, &[], MAX_SCHEMA_PROPERTY_RECURSION_DEPTH, &mut out);
        let paths: std::collections::HashSet<String> =
            out.iter().map(|(segs, _)| segs.join(".")).collect();
        assert!(paths.contains("top"), "expected top-level leaf");
        assert!(paths.contains("location"), "expected parent object node");
        assert!(paths.contains("location.lat"), "expected nested leaf");
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn get_by_segments_navigates_and_misses() {
        let v = json!({ "a": { "b": 7 }, "scalar": 1 });
        assert_eq!(
            get_by_segments(&v, &["a".into(), "b".into()]),
            Some(&json!(7))
        );
        // Missing intermediate key, and descending through a scalar, both miss.
        assert_eq!(get_by_segments(&v, &["a".into(), "missing".into()]), None);
        assert_eq!(get_by_segments(&v, &["scalar".into(), "b".into()]), None);
    }

    #[test]
    fn no_schema_json_is_noop() {
        let ctx = record_ctx(json!({"id": 1}), None, serde_json::Value::Null);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    // ── length tests ──────────────────────────────────────────────────────────

    fn ctx(value: serde_json::Value, args: serde_json::Value) -> FieldValidationContext {
        FieldValidationContext {
            filename: "rec-001.json".to_string(),
            field_path: "title".to_string(),
            value,
            record: json!({}),
            args,
        }
    }

    #[test]
    fn passes_under_limit() {
        assert!(length(&ctx(json!("hello"), json!({"max": 50}))).is_none());
    }

    #[test]
    fn fails_over_limit() {
        let r = length(&ctx(json!("x".repeat(101)), json!({"max": 100}))).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
        assert!(r.message.is_some());
    }

    #[test]
    fn fails_under_minimum() {
        let r = length(&ctx(json!("hi"), json!({"min": 3}))).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
        assert!(r.message.as_deref().unwrap_or("").contains("min 3"));
    }

    #[test]
    fn passes_at_exact_limit() {
        assert!(length(&ctx(json!("x".repeat(100)), json!({"max": 100}))).is_none());
    }

    #[test]
    fn passes_within_min_and_max() {
        assert!(length(&ctx(json!("hello"), json!({"min": 3, "max": 10}))).is_none());
    }

    #[test]
    fn null_value_passes() {
        assert!(length(&ctx(json!(null), json!({"max": 10}))).is_none());
    }

    #[test]
    fn missing_min_and_max_param_fails_as_warning() {
        let ctx_bad = FieldValidationContext {
            filename: "f.json".to_string(),
            field_path: "x".to_string(),
            value: json!("hello"),
            record: json!({}),
            args: json!({}),
        };
        let r = length(&ctx_bad).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
    }
}
