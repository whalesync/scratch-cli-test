use std::collections::HashMap;
use std::path::Path;

use scratch_core::error::EngineError;

use crate::impls::{
    AutoConvertTransformer, JsonPathTransformer, LookupFieldTransformer, SlugifyTransformer,
    SourceFkToDestFkTransformer, StringToNumberTransformer,
};
use crate::rhai_transform::RhaiTransformer;
use crate::traits::Transformer;

/// A registry of all available transformers, keyed by name.
///
/// Built-in transformers are registered automatically in `new()`.
/// Rhai script transformers can be loaded from a directory.
pub struct TransformerRegistry {
    transformers: HashMap<String, Box<dyn Transformer>>,
}

impl TransformerRegistry {
    /// Create a new registry with all 6 built-in transformers registered.
    pub fn new() -> Self {
        let mut registry = Self {
            transformers: HashMap::new(),
        };

        registry.register(Box::new(AutoConvertTransformer));
        registry.register(Box::new(SlugifyTransformer));
        registry.register(Box::new(StringToNumberTransformer));
        registry.register(Box::new(JsonPathTransformer));
        registry.register(Box::new(LookupFieldTransformer));
        registry.register(Box::new(SourceFkToDestFkTransformer));

        registry
    }

    /// Load all `.rhai` files from a directory and register them as transformers.
    ///
    /// Each file becomes a transformer whose name is the file stem (e.g. `my_transform.rhai`
    /// registers as "my_transform").
    pub fn load_rhai_dir(&mut self, dir: &Path) -> Result<(), EngineError> {
        if !dir.is_dir() {
            return Ok(());
        }

        let entries = std::fs::read_dir(dir).map_err(EngineError::Io)?;

        for entry in entries {
            let entry = entry.map_err(EngineError::Io)?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("rhai") {
                let transformer = RhaiTransformer::from_file(&path)?;
                self.register(Box::new(transformer));
            }
        }

        Ok(())
    }

    /// Register a transformer. Replaces any existing transformer with the same name.
    pub fn register(&mut self, t: Box<dyn Transformer>) {
        self.transformers.insert(t.name().to_string(), t);
    }

    /// Look up a transformer by name.
    pub fn get(&self, name: &str) -> Option<&dyn Transformer> {
        self.transformers.get(name).map(|b| b.as_ref())
    }

    /// List all registered transformer names.
    pub fn names(&self) -> Vec<&str> {
        self.transformers.keys().map(|s| s.as_str()).collect()
    }
}

impl Default for TransformerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_builtins_registered() {
        let registry = TransformerRegistry::new();
        assert!(registry.get("auto_convert").is_some());
        assert!(registry.get("slugify").is_some());
        assert!(registry.get("string_to_number").is_some());
        assert!(registry.get("jsonpath").is_some());
        assert!(registry.get("lookup_field").is_some());
        assert!(registry.get("source_fk_to_dest_fk").is_some());
    }

    #[test]
    fn unknown_returns_none() {
        let registry = TransformerRegistry::new();
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn names_returns_all() {
        let registry = TransformerRegistry::new();
        let names = registry.names();
        assert_eq!(names.len(), 6);
        assert!(names.contains(&"slugify"));
        assert!(names.contains(&"auto_convert"));
    }

    #[test]
    fn load_rhai_nonexistent_dir_ok() {
        let mut registry = TransformerRegistry::new();
        let result = registry.load_rhai_dir(Path::new("/nonexistent/path"));
        assert!(result.is_ok());
    }
}
