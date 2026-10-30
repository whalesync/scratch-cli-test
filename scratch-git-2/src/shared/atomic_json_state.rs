//! Shared durability + corruption-tolerance helpers for the small per-connection
//! JSON state files (`accepted-patches.json`, `failed-patches.json`,
//! `unreviewed-changes.json`).
//!
//! All three files are written with the same discipline — serialize, write to a
//! `<file>.tmp.<pid>` temp, fsync the temp, then atomically `rename` over the
//! target — and read with the same "missing/empty == no state yet" convention.
//! This module owns the two cross-cutting concerns that protect that discipline
//! against partially-written / out-of-band-corrupted files:
//!
//! 1. [`read_json_state_file_tolerating_trailing_padding`] — read the bytes,
//!    treating a file that is missing, empty, or entirely NUL/whitespace padding
//!    as "no state yet", and stripping any trailing NUL/whitespace padding before
//!    the caller parses. This neutralizes the *trailing-NUL-bytes-after-a-complete-
//!    `}`* corruption signature that an out-of-band writer (a manual edit, a
//!    cloud-sync placeholder, or power-loss block zero-fill) can leave, while
//!    still failing loud on genuinely truncated / structurally-broken JSON (an
//!    incomplete value does not parse even after the padding is trimmed).
//!
//! 2. [`fsync_parent_directory_best_effort`] — fsync the directory that contains
//!    a freshly-renamed file so the rename itself is durable across a crash
//!    (closing the "data fsynced, rename not" reorder window on crash-unsafe
//!    filesystems).
//!
//! 3. [`write_bytes_to_file_atomically`] — the same temp → fsync → rename →
//!    dir-fsync discipline for an arbitrary file's raw bytes (e.g. record
//!    files), for callers that don't own a typed state envelope.
//!
//! Each state-file module keeps its own typed envelope + format-version handling
//! and calls into here for the byte-level read and the post-rename dir fsync.

// `shared` is compiled for both binaries; only the CLI reaches into this module
// today. Allow at module scope to keep the service binary's build warning-clean.
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::Context;

/// The length of `bytes` excluding any trailing run of NUL (`0x00`) and ASCII
/// whitespace bytes. Trailing whitespace after a JSON document is insignificant
/// (serde ignores it anyway), and NUL bytes never appear in a well-formed file —
/// so trimming this run is a no-op for a clean file and removes the zero-fill /
/// padding tail from a corrupted one. Returns `0` when every byte is padding.
fn length_excluding_trailing_nul_and_whitespace_bytes(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .rposition(|&byte| byte != 0x00 && !byte.is_ascii_whitespace())
        .map(|last_meaningful_index| last_meaningful_index + 1)
        .unwrap_or(0)
}

/// Read a small JSON state file's bytes for parsing, tolerating trailing padding
/// left by an out-of-band writer.
///
/// Returns:
/// * `Ok(None)` when the file is missing, empty, or made up entirely of
///   NUL/whitespace padding — all of which mean "no state yet" (the latter two
///   are known crash / out-of-band-corruption artifacts and are treated as empty
///   rather than as a parse failure).
/// * `Ok(Some(bytes))` otherwise, with any trailing NUL/whitespace padding
///   already stripped so the caller can parse straight into its typed envelope.
///
/// When NUL padding is stripped, emits a single structured stderr warning — its
/// presence means the file was modified outside Scratch's atomic-write path (a
/// manual edit, a cloud-sync placeholder, or a power-loss). The warning fires
/// whether or not a document survives ahead of the padding: if one does, the
/// note says it was recovered in memory; if the file was *entirely* zero-filled
/// the staged state is lost (there is nothing to recover) and the note says so —
/// surfacing that more-severe case rather than swallowing it as a benign empty
/// file. Either way the file is rewritten cleanly by the next mutating operation
/// (which serializes the parsed-and-fixed state back through `save_atomic` under
/// the workspace lock).
pub fn read_json_state_file_tolerating_trailing_padding(
    file_path: &Path,
) -> anyhow::Result<Option<Vec<u8>>> {
    if !file_path.exists() {
        return Ok(None);
    }
    let mut file_bytes =
        fs::read(file_path).with_context(|| format!("failed to read {}", file_path.display()))?;

    let length_without_trailing_padding =
        length_excluding_trailing_nul_and_whitespace_bytes(&file_bytes);
    let stripped_padding_contained_a_nul_byte =
        file_bytes[length_without_trailing_padding..].contains(&0x00);
    let stripped_padding_byte_count = file_bytes.len() - length_without_trailing_padding;
    file_bytes.truncate(length_without_trailing_padding);

    // Warn before the empty-return so a wholly zero-filled file (total loss of
    // the staged state) is surfaced too — not just the recoverable case where a
    // complete document precedes the padding.
    if stripped_padding_contained_a_nul_byte {
        let recovery_outcome = if file_bytes.is_empty() {
            "no_data_survived;staged_state_lost"
        } else {
            "recovered_in_memory"
        };
        eprintln!(
            "[json_state] event=trailing_nul_padding_detected stripped_bytes={stripped_padding_byte_count} path={} note=file_modified_outside_scratch_or_partially_written;{recovery_outcome};will_rewrite_clean_on_next_write",
            file_path.display()
        );
    }

    if file_bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(file_bytes))
}

/// fsync the directory that contains `file_path` so a file just `rename`d into it
/// is durable across a crash. The temp file's *contents* are already fsynced
/// before the rename; this flushes the *rename* (a directory-metadata change) so
/// the two can't be reordered into a window where a crash leaves the new name
/// pointing at not-yet-flushed data.
///
/// Unix only — directory fsync is not supported on Windows, where this is a
/// no-op. Errors are intentionally swallowed: this is durability hardening on top
/// of an already-successful write, and must never turn a successful write into a
/// failure.
pub fn fsync_parent_directory_best_effort(file_path: &Path) {
    #[cfg(unix)]
    {
        let parent_directory = match file_path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        if let Ok(directory_handle) = fs::File::open(parent_directory) {
            let _ = directory_handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = file_path;
    }
}

/// Atomically replace `file_path` with `bytes`: write a hidden sibling temp file
/// (`.<name>.tmp.<pid>`), fsync it, `rename` it over the target, then fsync the
/// parent directory so the rename itself is durable. A crash mid-write leaves
/// either the old file or the new one — never a half-written file. Creates the
/// parent directory if needed. Because the final step is a `rename`, a symlink
/// at `file_path` is replaced rather than written through. On failure the temp
/// file is removed (best-effort) so it can't linger next to the target.
pub fn write_bytes_to_file_atomically(file_path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent_directory = file_path.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "cannot write {} atomically: it has no parent directory",
            file_path.display()
        )
    })?;
    fs::create_dir_all(parent_directory)
        .with_context(|| format!("failed to create dir {}", parent_directory.display()))?;
    let file_name = file_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let temp_file_path = parent_directory.join(format!(".{file_name}.tmp.{}", std::process::id()));

    let write_temp_file_then_rename_over_target = || -> anyhow::Result<()> {
        {
            let mut temp_file = fs::File::create(&temp_file_path)
                .with_context(|| format!("failed to open {}", temp_file_path.display()))?;
            temp_file
                .write_all(bytes)
                .with_context(|| format!("failed to write {}", temp_file_path.display()))?;
            temp_file
                .sync_all()
                .with_context(|| format!("failed to fsync {}", temp_file_path.display()))?;
        }
        fs::rename(&temp_file_path, file_path)
            .with_context(|| format!("failed to rename to {}", file_path.display()))
    };
    if let Err(write_or_rename_error) = write_temp_file_then_rename_over_target() {
        let _ = fs::remove_file(&temp_file_path);
        return Err(write_or_rename_error);
    }
    fsync_parent_directory_best_effort(file_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn trims_trailing_nul_and_whitespace_but_not_interior() {
        assert_eq!(length_excluding_trailing_nul_and_whitespace_bytes(b"{}"), 2);
        assert_eq!(
            length_excluding_trailing_nul_and_whitespace_bytes(b"{}\n"),
            2
        );
        assert_eq!(
            length_excluding_trailing_nul_and_whitespace_bytes(b"{}\n\0\0\0"),
            2
        );
        assert_eq!(
            length_excluding_trailing_nul_and_whitespace_bytes(b"{}\0\0 \n\t"),
            2
        );
        // Interior NUL/whitespace (e.g. a value containing a space) is preserved.
        assert_eq!(
            length_excluding_trailing_nul_and_whitespace_bytes(b"{\"a\":\"x y\"}"),
            11
        );
        // All padding collapses to length 0.
        assert_eq!(
            length_excluding_trailing_nul_and_whitespace_bytes(b"\0\0\0"),
            0
        );
        assert_eq!(length_excluding_trailing_nul_and_whitespace_bytes(b""), 0);
    }

    #[test]
    fn read_returns_none_for_missing_empty_or_all_padding() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("state.json");

        // Missing.
        assert!(read_json_state_file_tolerating_trailing_padding(&p)
            .unwrap()
            .is_none());

        // Empty.
        fs::write(&p, b"").unwrap();
        assert!(read_json_state_file_tolerating_trailing_padding(&p)
            .unwrap()
            .is_none());

        // Entirely NUL/whitespace padding (a zero-fill crash artifact).
        fs::write(&p, b"\0\0\0\0").unwrap();
        assert!(read_json_state_file_tolerating_trailing_padding(&p)
            .unwrap()
            .is_none());
    }

    #[test]
    fn read_strips_trailing_nul_padding_after_a_complete_document() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("state.json");
        fs::write(&p, b"{\"version\":2,\"patches\":[]}\n\0\0\0").unwrap();
        let recovered = read_json_state_file_tolerating_trailing_padding(&p)
            .unwrap()
            .expect("a non-empty document must be returned");
        assert_eq!(recovered, b"{\"version\":2,\"patches\":[]}");
    }

    #[test]
    fn read_leaves_a_clean_document_untouched() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("state.json");
        fs::write(&p, b"{\"version\":2,\"patches\":[]}\n").unwrap();
        let recovered = read_json_state_file_tolerating_trailing_padding(&p)
            .unwrap()
            .unwrap();
        // Only the insignificant trailing newline is trimmed; the document is intact.
        assert_eq!(recovered, b"{\"version\":2,\"patches\":[]}");
    }

    #[test]
    fn write_bytes_atomically_writes_exact_bytes_and_leaves_no_temp_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nested").join("daily.yaml");
        let bytes_with_crlf_and_bom = b"\xEF\xBB\xBFname: Daily\r\nsteps: []\r\n";

        write_bytes_to_file_atomically(&target, bytes_with_crlf_and_bom).unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes_with_crlf_and_bom);

        // Overwrite replaces the content wholesale.
        write_bytes_to_file_atomically(&target, b"name: Weekly\n").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"name: Weekly\n");

        let leftover_entries: Vec<String> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(leftover_entries, vec!["daily.yaml".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn write_bytes_atomically_replaces_a_symlink_instead_of_writing_through_it() {
        let dir = tempdir().unwrap();
        let symlink_target_outside = dir.path().join("outside.yaml");
        fs::write(&symlink_target_outside, b"original").unwrap();
        let link_path = dir.path().join("daily.yaml");
        std::os::unix::fs::symlink(&symlink_target_outside, &link_path).unwrap();

        write_bytes_to_file_atomically(&link_path, b"replaced").unwrap();

        assert_eq!(fs::read(&symlink_target_outside).unwrap(), b"original");
        assert!(!fs::symlink_metadata(&link_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&link_path).unwrap(), b"replaced");
    }

    #[test]
    fn fsync_parent_directory_is_a_safe_noop_on_a_real_dir() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("state.json");
        fs::write(&p, b"{}").unwrap();
        // Must not panic or error for a normal file in a normal directory.
        fsync_parent_directory_best_effort(&p);
    }
}
