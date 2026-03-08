use std::collections::HashMap;
use std::path::Path;

use scratch_core::error::EngineError;

use crate::impls::{JsonSchemaValidator, ReadonlyFieldsValidator, RecordRefsValidator};
use crate::rhai_validate::RhaiValidator;
use crate::traits::Validator;

/// A registry of all available validators, keyed by name.
///
/// Built-in validators are registered automatically in `new()`.
/// Rhai script validators can be loaded from a directory.
pub struct ValidatorRegistry {
    validators: HashMap<String, Box<dyn Validator>>,
}

impl ValidatorRegistry {
    /// Create a new registry with all built-in validators registered.
    pub fn new() -> Self {
        let mut registry = Self {
            validators: HashMap::new(),
        };

        registry.register(Box::new(JsonSchemaValidator));
        registry.register(Box::new(ReadonlyFieldsValidator));
        registry.register(Box::new(RecordRefsValidator));

        registry
    }

    /// Load all `.rhai` files from a directory and register them as validators.
    ///
    /// Each file becomes a validator whose name is the file stem (e.g. `no_empty_titles.rhai`
    /// registers as "no_empty_titles").
    pub fn load_rhai_dir(&mut self, dir: &Path) -> Result<(), EngineError> {
        if !dir.is_dir() {
            return Ok(());
        }

        let entries = std::fs::read_dir(dir).map_err(EngineError::Io)?;

        for entry in entries {
            let entry = entry.map_err(EngineError::Io)?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("rhai") {
                let validator = RhaiValidator::from_file(&path)?;
                self.register(Box::new(validator));
            }
        }

        Ok(())
    }

    /// Register a validator. Replaces any existing validator with the same name.
    pub fn register(&mut self, v: Box<dyn Validator>) {
        self.validators.insert(v.name().to_string(), v);
    }

    /// Look up a validator by name.
    pub fn get(&self, name: &str) -> Option<&dyn Validator> {
        self.validators.get(name).map(|b| b.as_ref())
    }

    /// List all registered validator names.
    pub fn names(&self) -> Vec<&str> {
        self.validators.keys().map(|s| s.as_str()).collect()
    }

    /// Get all registered validators.
    pub fn all(&self) -> Vec<&dyn Validator> {
        self.validators.values().map(|b| b.as_ref()).collect()
    }
}

impl Default for ValidatorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_builtins_registered() {
        let registry = ValidatorRegistry::new();
        assert!(registry.get("json_schema").is_some());
        assert!(registry.get("readonly_fields").is_some());
        assert!(registry.get("record_refs").is_some());
    }

    #[test]
    fn unknown_returns_none() {
        let registry = ValidatorRegistry::new();
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn names_returns_all() {
        let registry = ValidatorRegistry::new();
        let names = registry.names();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"json_schema"));
        assert!(names.contains(&"readonly_fields"));
        assert!(names.contains(&"record_refs"));
    }

    #[test]
    fn load_rhai_nonexistent_dir_ok() {
        let mut registry = ValidatorRegistry::new();
        let result = registry.load_rhai_dir(Path::new("/nonexistent/path"));
        assert!(result.is_ok());
    }

    #[test]
    fn all_returns_everything() {
        let registry = ValidatorRegistry::new();
        assert_eq!(registry.all().len(), 3);
    }
}
