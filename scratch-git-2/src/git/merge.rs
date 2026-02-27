use crate::error::AppError;

/// 3-way merge of file contents with conflict resolution using "ours" strategy.
pub fn merge_file_contents(base: &str, ours: &str, theirs: &str) -> Result<String, AppError> {
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

    let merged = String::from_utf8(out)
        .map_err(|e| AppError::internal(format!("Merge result not UTF-8: {}", e)))?;

    Ok(merged)
}
