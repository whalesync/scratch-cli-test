use std::path::Path;

use rhai::{Dynamic, Engine, Map, Scope, AST};
use scratch_core::error::EngineError;
use serde_json::Value;

use crate::traits::{ValidateContext, ValidationIssue, Validator};

/// A validator loaded from a `.rhai` script file.
///
/// The script receives these variables:
/// - `record`: the record being validated (as a Rhai Map)
/// - `options`: per-validator options (as a Rhai Map)
/// - `original`: the original record before edits (as a Rhai Map, or `()` if new)
/// - `file_path`: path string of the record file
///
/// The script should return an array of error maps, each with `path` and `message` keys.
/// An optional `warning` key (boolean) marks the issue as non-blocking.
/// Returning an empty array means the record is valid.
///
/// The engine is sandboxed with operation limits to prevent runaway scripts.
pub struct RhaiValidator {
    name: String,
    engine: Engine,
    ast: AST,
}

impl RhaiValidator {
    /// Load a Rhai validator from a `.rhai` file.
    ///
    /// The validator name is derived from the file stem.
    pub fn from_file(path: &Path) -> Result<Self, EngineError> {
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let source = std::fs::read_to_string(path).map_err(EngineError::Io)?;
        Self::from_source(name, &source)
    }

    /// Load a Rhai validator from source code.
    pub fn from_source(name: String, source: &str) -> Result<Self, EngineError> {
        let mut engine = Engine::new();
        engine.set_max_operations(1_000_000);
        engine.set_max_string_size(1_000_000);
        engine.set_max_array_size(100_000);
        engine.set_max_map_size(100_000);

        let ast = engine.compile(source).map_err(|e| {
            EngineError::Other(format!("Rhai compile error in '{}': {}", name, e))
        })?;

        Ok(Self { name, engine, ast })
    }
}

impl Validator for RhaiValidator {
    fn name(&self) -> &str {
        &self.name
    }

    fn validate(&self, ctx: &ValidateContext) -> Vec<ValidationIssue> {
        let mut scope = Scope::new();

        scope.push("record", json_to_dynamic(&ctx.record));
        scope.push("options", options_to_dynamic(&ctx.options));
        scope.push("file_path", ctx.file_path.clone());

        let original = match &ctx.original_record {
            Some(v) => json_to_dynamic(v),
            None => Dynamic::UNIT,
        };
        scope.push("original", original);

        match self
            .engine
            .eval_ast_with_scope::<Dynamic>(&mut scope, &self.ast)
        {
            Ok(result) => parse_script_result(result),
            Err(e) => vec![ValidationIssue {
                path: String::new(),
                message: format!("Rhai validator '{}' failed: {}", self.name, e),
                warning: false,
            }],
        }
    }
}

/// Parse the script return value into ValidationIssues.
///
/// Expects an array of maps with `path` and `message` keys.
/// Also accepts a single map (wrapped into a one-element vec).
fn parse_script_result(result: Dynamic) -> Vec<ValidationIssue> {
    if result.is_unit() {
        return vec![];
    }

    if result.is_array() {
        let arr: Vec<Dynamic> = result.into_array().unwrap();
        return arr.into_iter().filter_map(parse_issue_map).collect();
    }

    if result.is_map() {
        return parse_issue_map(result).into_iter().collect();
    }

    // If the script returned a string, treat it as a single error message.
    if result.is_string() {
        return vec![ValidationIssue {
            path: String::new(),
            message: result.into_string().unwrap(),
            warning: false,
        }];
    }

    vec![]
}

fn parse_issue_map(value: Dynamic) -> Option<ValidationIssue> {
    if !value.is_map() {
        return None;
    }
    let map: Map = value.cast::<Map>();
    let message = map
        .get("message")
        .and_then(|v| v.clone().into_string().ok())?;
    let path = map
        .get("path")
        .and_then(|v| v.clone().into_string().ok())
        .unwrap_or_default();
    let warning = map
        .get("warning")
        .and_then(|v| v.as_bool().ok())
        .unwrap_or(false);
    Some(ValidationIssue {
        path,
        message,
        warning,
    })
}

// ---------------------------------------------------------------------------
// JSON ↔ Dynamic conversion (mirrors scratch-transform/rhai_transform.rs)
// ---------------------------------------------------------------------------

fn json_to_dynamic(value: &Value) -> Dynamic {
    match value {
        Value::Null => Dynamic::UNIT,
        Value::Bool(b) => Dynamic::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                Dynamic::from(n.to_string())
            }
        }
        Value::String(s) => Dynamic::from(s.clone()),
        Value::Array(arr) => {
            let rhai_arr: Vec<Dynamic> = arr.iter().map(json_to_dynamic).collect();
            Dynamic::from(rhai_arr)
        }
        Value::Object(map) => {
            let mut rhai_map = Map::new();
            for (k, v) in map {
                rhai_map.insert(k.clone().into(), json_to_dynamic(v));
            }
            Dynamic::from(rhai_map)
        }
    }
}

fn options_to_dynamic(options: &std::collections::HashMap<String, Value>) -> Dynamic {
    let mut map = Map::new();
    for (k, v) in options {
        map.insert(k.clone().into(), json_to_dynamic(v));
    }
    Dynamic::from(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn make_ctx(record: Value) -> ValidateContext {
        ValidateContext {
            record,
            original_record: None,
            schema: None,
            folder_records: HashMap::new(),
            options: HashMap::new(),
            file_path: "/test/rec.json".into(),
        }
    }

    #[test]
    fn script_returns_empty_array() {
        let v = RhaiValidator::from_source("ok".into(), "[]").unwrap();
        let issues = v.validate(&make_ctx(json!({"name": "Alice"})));
        assert!(issues.is_empty());
    }

    #[test]
    fn script_returns_error() {
        let v = RhaiValidator::from_source(
            "check_name".into(),
            r#"
            if record["name"] == () {
                [#{ path: "/name", message: "name is required" }]
            } else {
                []
            }
            "#,
        )
        .unwrap();

        let issues = v.validate(&make_ctx(json!({})));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "/name");
        assert_eq!(issues[0].message, "name is required");
        assert!(!issues[0].warning);
    }

    #[test]
    fn script_returns_warning() {
        let v = RhaiValidator::from_source(
            "warn".into(),
            r#"[#{ path: "", message: "heads up", warning: true }]"#,
        )
        .unwrap();
        let issues = v.validate(&make_ctx(json!({})));
        assert_eq!(issues.len(), 1);
        assert!(issues[0].warning);
    }

    #[test]
    fn script_runtime_error() {
        let v = RhaiValidator::from_source("bad".into(), r#"throw "oops""#).unwrap();
        let issues = v.validate(&make_ctx(json!({})));
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("oops"));
    }

    #[test]
    fn compile_error() {
        let result = RhaiValidator::from_source("bad".into(), "let x = ;; invalid");
        assert!(result.is_err());
    }

    #[test]
    fn script_accesses_original() {
        let v = RhaiValidator::from_source(
            "check_original".into(),
            r#"
            if original == () {
                [#{ path: "", message: "no original" }]
            } else {
                []
            }
            "#,
        )
        .unwrap();

        // No original → script reports it
        let issues = v.validate(&make_ctx(json!({})));
        assert_eq!(issues.len(), 1);

        // With original → passes
        let mut ctx = make_ctx(json!({}));
        ctx.original_record = Some(json!({"name": "Old"}));
        assert!(v.validate(&ctx).is_empty());
    }

    #[test]
    fn script_returns_string_as_error() {
        let v = RhaiValidator::from_source("str".into(), r#""something wrong""#).unwrap();
        let issues = v.validate(&make_ctx(json!({})));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].message, "something wrong");
    }
}
