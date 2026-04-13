//! Normalization for logical paths stored in git trees (service + CLI).

/// Split on `/`, drop empty segments, reject `.` / `..`, rejoin with `/`.
/// Leading slashes are not preserved; callers treat paths as repo-relative segments.
pub fn normalize_logical_git_path(path: &str) -> Result<String, String> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err("invalid empty file path".to_string());
    }
    for seg in &segments {
        if *seg == "." || *seg == ".." {
            return Err(format!("invalid git path component '{seg}'"));
        }
    }
    Ok(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_double_slashes() {
        assert_eq!(normalize_logical_git_path("a//b/c").unwrap(), "a/b/c");
        assert_eq!(normalize_logical_git_path("/a//b").unwrap(), "a/b");
    }

    #[test]
    fn rejects_dot_components() {
        assert!(normalize_logical_git_path("a/./b").is_err());
        assert!(normalize_logical_git_path("a/../b").is_err());
    }
}
