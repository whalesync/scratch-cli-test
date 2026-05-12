/// Regression tests: clap must accept hyphen-prefixed values for `--folder`
/// and `--file` on commands that take user-controlled filenames/folders.
///
/// Records from external services can have IDs or slugs that start with `-`.
/// Without `allow_hyphen_values = true`, clap parses `-foo.json` as combined
/// short flags and bails out with `error: unexpected argument '-f' found`.
use std::process::Command;
use tempfile::TempDir;

/// Run `scratchmd <args>` from a clean tempdir and return (status, stdout, stderr).
fn run_scratchmd(args: &[&str]) -> (std::process::ExitStatus, String, String) {
    let binary = env!("CARGO_BIN_EXE_scratchmd");
    let tmp = TempDir::new().expect("create tempdir");
    let output = Command::new(binary)
        .args(args)
        .current_dir(tmp.path())
        .output()
        .unwrap_or_else(|e| panic!("failed to run scratchmd: {e}"));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    (output.status, stdout, stderr)
}

/// Assert the combined output does not contain a clap arg-parsing error.
/// Whatever happens downstream (missing workspace, folder not found, etc.)
/// is fine — we only care that clap accepted the values.
fn assert_no_clap_parse_error(args: &[&str], stdout: &str, stderr: &str) {
    let combined = format!("{stdout}\n{stderr}");
    assert!(
        !combined.contains("unexpected argument"),
        "clap rejected hyphen-prefixed value for `{}`:\n{combined}",
        args.join(" "),
    );
    assert!(
        !combined.contains("error: invalid value"),
        "clap rejected hyphen-prefixed value for `{}`:\n{combined}",
        args.join(" "),
    );
}

#[test]
fn reindex_files_accepts_hyphen_prefixed_folder_and_file() {
    let args = [
        "reindex-files",
        "--folder",
        "-tricky-folder",
        "--file",
        "-tricky-file.json",
        "--file",
        "normal.json",
    ];
    let (_, stdout, stderr) = run_scratchmd(&args);
    assert_no_clap_parse_error(&args, &stdout, &stderr);
}

#[test]
fn reindex_files_columns_accepts_hyphen_prefixed_folder_and_file() {
    let args = [
        "reindex-files-columns",
        "--folder",
        "-tricky-folder",
        "--file",
        "-tricky-file.json",
    ];
    let (_, stdout, stderr) = run_scratchmd(&args);
    assert_no_clap_parse_error(&args, &stdout, &stderr);
}
