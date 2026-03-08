use std::path::Path;

use rhai::{Engine, AST, Dynamic, Map, Scope};
use scratch_core::error::EngineError;
use scratch_core::types::SyncPhase;
use serde_json::Value;

use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};

/// A transformer loaded from a `.rhai` script file.
///
/// The script receives two variables:
/// - `value`: the current value (as a Rhai Dynamic)
/// - `options`: the transformer options (as a Rhai Map)
///
/// The script should return the transformed value.
///
/// The engine is sandboxed with operation limits to prevent runaway scripts.
pub struct RhaiTransformer {
    name: String,
    engine: Engine,
    ast: AST,
    phases: Vec<SyncPhase>,
}

impl RhaiTransformer {
    /// Load a Rhai transformer from a `.rhai` file.
    ///
    /// The transformer name is derived from the file stem.
    /// An optional `// phases: DATA, FOREIGN_KEY_MAPPING` comment on the first line
    /// controls which phases the transformer runs in (default: DATA only).
    pub fn from_file(path: &Path) -> Result<Self, EngineError> {
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let source = std::fs::read_to_string(path).map_err(EngineError::Io)?;

        Self::from_source(name, &source)
    }

    /// Load a Rhai transformer from source code.
    pub fn from_source(name: String, source: &str) -> Result<Self, EngineError> {
        let phases = parse_phases(source);

        let mut engine = Engine::new();
        // Sandbox: limit operations to prevent infinite loops.
        engine.set_max_operations(1_000_000);
        // Prevent access to the file system, network, etc.
        engine.set_max_string_size(1_000_000);
        engine.set_max_array_size(100_000);
        engine.set_max_map_size(100_000);

        let ast = engine.compile(source).map_err(|e| {
            EngineError::Other(format!("Rhai compile error in '{}': {}", name, e))
        })?;

        Ok(Self {
            name,
            engine,
            ast,
            phases,
        })
    }
}

impl Transformer for RhaiTransformer {
    fn name(&self) -> &str {
        &self.name
    }

    fn phases(&self) -> &[SyncPhase] {
        &self.phases
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let mut scope = Scope::new();

        // Convert source_value to Rhai Dynamic.
        let dyn_value = json_to_dynamic(&ctx.source_value);
        scope.push("value", dyn_value);

        // Convert options to Rhai Map.
        let dyn_options = options_to_dynamic(&ctx.options);
        scope.push("options", dyn_options);

        match self
            .engine
            .eval_ast_with_scope::<Dynamic>(&mut scope, &self.ast)
        {
            Ok(result) => {
                let value = dynamic_to_json(result);
                TransformResult::Value(value)
            }
            Err(e) => TransformResult::Error(format!(
                "Rhai script '{}' failed: {}",
                self.name, e
            )),
        }
    }
}

/// Parse phase declarations from the first comment line of a Rhai script.
/// Format: `// phases: DATA, FOREIGN_KEY_MAPPING`
fn parse_phases(source: &str) -> Vec<SyncPhase> {
    if let Some(first_line) = source.lines().next() {
        let trimmed = first_line.trim();
        if let Some(rest) = trimmed.strip_prefix("// phases:") {
            let phases: Vec<SyncPhase> = rest
                .split(',')
                .filter_map(|s| match s.trim() {
                    "DATA" => Some(SyncPhase::Data),
                    "FOREIGN_KEY_MAPPING" => Some(SyncPhase::ForeignKeyMapping),
                    _ => None,
                })
                .collect();
            if !phases.is_empty() {
                return phases;
            }
        }
    }
    vec![SyncPhase::Data]
}

/// Convert a serde_json::Value to a Rhai Dynamic.
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

/// Convert Rhai Dynamic back to serde_json::Value.
fn dynamic_to_json(value: Dynamic) -> Value {
    if value.is_unit() {
        Value::Null
    } else if value.is_bool() {
        Value::Bool(value.as_bool().unwrap())
    } else if value.is_int() {
        Value::Number(value.as_int().unwrap().into())
    } else if value.is_float() {
        match serde_json::Number::from_f64(value.as_float().unwrap()) {
            Some(n) => Value::Number(n),
            None => Value::Null,
        }
    } else if value.is_string() {
        Value::String(value.into_string().unwrap())
    } else if value.is_array() {
        let arr: Vec<Dynamic> = value.into_array().unwrap();
        Value::Array(arr.into_iter().map(dynamic_to_json).collect())
    } else if value.is_map() {
        let map: Map = value.cast::<Map>();
        let mut obj = serde_json::Map::new();
        for (k, v) in map {
            obj.insert(k.to_string(), dynamic_to_json(v));
        }
        Value::Object(obj)
    } else {
        // Fallback: convert to string.
        Value::String(value.to_string())
    }
}

/// Convert options HashMap to a Rhai Dynamic Map.
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
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;

    fn make_ctx(value: Value, opts: HashMap<String, Value>) -> TransformContext {
        TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "f".into(),
            source_value: value,
            destination_field_path: "f".into(),
            destination_value: None,
            lookup_tools: None,
            options: opts,
            phase: SyncPhase::Data,
        }
    }

    #[test]
    fn identity_script() {
        let t = RhaiTransformer::from_source(
            "identity".into(),
            "value",
        )
        .unwrap();
        assert_eq!(t.name(), "identity");

        let ctx = make_ctx(json!("hello"), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("hello")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn uppercase_script() {
        let t = RhaiTransformer::from_source(
            "upper".into(),
            r#"value.to_upper()"#,
        )
        .unwrap();

        let ctx = make_ctx(json!("hello"), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("HELLO")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn script_with_options() {
        let t = RhaiTransformer::from_source(
            "prefix".into(),
            r#"let pfx = options["prefix"]; pfx + value"#,
        )
        .unwrap();

        let mut opts = HashMap::new();
        opts.insert("prefix".into(), json!("pre_"));
        let ctx = make_ctx(json!("test"), opts);
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("pre_test")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn numeric_script() {
        let t = RhaiTransformer::from_source(
            "double".into(),
            "value * 2",
        )
        .unwrap();

        let ctx = make_ctx(json!(21), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(42)),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn compile_error() {
        let result = RhaiTransformer::from_source(
            "bad".into(),
            "let x = ;; invalid",
        );
        assert!(result.is_err());
    }

    #[test]
    fn runtime_error() {
        let t = RhaiTransformer::from_source(
            "bad_runtime".into(),
            r#"throw "oops""#,
        )
        .unwrap();

        let ctx = make_ctx(json!("hello"), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Error(e) => assert!(e.contains("oops")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn phase_parsing() {
        assert_eq!(parse_phases("// phases: DATA\nvalue"), vec![SyncPhase::Data]);
        assert_eq!(
            parse_phases("// phases: DATA, FOREIGN_KEY_MAPPING\nvalue"),
            vec![SyncPhase::Data, SyncPhase::ForeignKeyMapping]
        );
        assert_eq!(
            parse_phases("// phases: FOREIGN_KEY_MAPPING\nvalue"),
            vec![SyncPhase::ForeignKeyMapping]
        );
        // Default when no phase comment
        assert_eq!(parse_phases("value"), vec![SyncPhase::Data]);
    }

    #[test]
    fn null_handling() {
        let t = RhaiTransformer::from_source("null_check".into(), "value").unwrap();
        let ctx = make_ctx(json!(null), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(null)),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn array_handling() {
        let t = RhaiTransformer::from_source(
            "arr_len".into(),
            "value.len()",
        )
        .unwrap();

        let ctx = make_ctx(json!([1, 2, 3]), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(3)),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn map_handling() {
        let t = RhaiTransformer::from_source(
            "get_key".into(),
            r#"value["name"]"#,
        )
        .unwrap();

        let ctx = make_ctx(json!({"name": "Alice"}), HashMap::new());
        match t.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("Alice")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }
}
