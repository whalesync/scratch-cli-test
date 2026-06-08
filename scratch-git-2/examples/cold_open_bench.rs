// Benchmark for DEV-10327: the cold-open cost of deriving review state from
// `gix status` (the proposed path) vs the folder_index "twice-parse" sweep it
// would replace.
//
// Usage:
//   cargo run --example cold_open_bench --release -- [num_files] [num_dirty]
//   (defaults: 20000 files, 1 dirty)
//
// It builds a synthetic connection worktree of `num_files` JSON records under a
// few folders and commits them to `main`, so the git index == HEAD == worktree
// — exactly the state a connection is in right after init/pull/publish
// (`worktree_reset_mixed` keeps the index synced; a plain workspace *open* does
// no ref advance, so the index is already fresh). Then it times, on the SAME
// (warm) OS page cache:
//
//   A. gix status (index->worktree), clean corpus      — the realistic open
//   B. gix status (index->worktree), `num_dirty` dirty — mostly-clean open
//      including the post-filter that reads each flagged path's blob from main
//   C. the "old sweep": read+parse every working file + read+parse every main
//      blob (what reindex_files pays for every file on a cold folder_index DB).
//      Measured both serial and rayon-parallel so the sweep gets its best case.
//
// gix status is internally rayon-parallel; the sweep's parallel variant uses
// rayon too, so C-parallel vs A is an apples-to-apples CPU comparison.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use gix::bstr::BString;
use rayon::prelude::*;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {:?} failed", args);
}

/// A record body shaped roughly like a real connector record: a handful of
/// scalar fields plus a couple of nested objects, ~1-2 KB.
fn sample_record(i: usize) -> Vec<u8> {
    let v = serde_json::json!({
        "id": format!("rec{i:08}"),
        "createdTime": "2026-06-08T00:00:00.000Z",
        "fields": {
            "Name": format!("Record number {i}"),
            "Status": if i % 3 == 0 { "Active" } else { "Archived" },
            "Score": i % 100,
            "Tags": ["alpha", "beta", "gamma"],
            "Notes": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. \
                      Sed do eiusmod tempor incididunt ut labore et dolore magna.",
            "Nested": { "a": i, "b": format!("{i}-x"), "c": [1, 2, 3, 4, 5] },
        },
    });
    serde_json::to_vec_pretty(&v).unwrap()
}

const FOLDERS: [&str; 4] = ["Companies", "Contacts", "Deals", "Notes"];

fn rel_path(i: usize) -> String {
    format!("{}/rec{i:06}.json", FOLDERS[i % FOLDERS.len()])
}

/// gix status (index -> worktree), mirroring the real helper's config
/// (untracked files emitted individually). Returns (elapsed, flagged_paths).
fn run_gix_status(repo: &gix::Repository) -> anyhow::Result<(std::time::Duration, Vec<String>)> {
    let t = Instant::now();
    let platform = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files);
    let iter = platform.into_index_worktree_iter(Vec::<BString>::new())?;
    let mut flagged = Vec::new();
    for item in iter {
        let item = item?;
        if item.summary().is_some() {
            flagged.push(String::from_utf8_lossy(item.rela_path()).into_owned());
        }
    }
    Ok((t.elapsed(), flagged))
}

/// Read every blob of `main` via the production shell-out path
/// (`ls-tree -r` piped to `cat-file --batch`) and parse each as JSON.
/// This is what folder_index's cold seed (read_main_blobs_for_folder) pays.
fn read_and_parse_all_main_blobs(root: &Path) -> anyhow::Result<(usize, usize)> {
    // ls-tree -r main --format='%(objectname) %(path)'
    let ls = Command::new("git")
        .current_dir(root)
        .args(["ls-tree", "-r", "main", "--format=%(objectname)"])
        .output()?;
    let oids: Vec<String> = String::from_utf8(ls.stdout)?
        .lines()
        .map(|s| s.to_string())
        .collect();

    let mut child = Command::new("git")
        .current_dir(root)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let oids_for_writer = oids.clone();
    let writer = std::thread::spawn(move || {
        for oid in &oids_for_writer {
            let _ = writeln!(stdin, "{oid}");
        }
    });

    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut bytes_read = 0usize;
    let mut parsed = 0usize;
    for _ in 0..oids.len() {
        // header line: "<oid> blob <size>\n"
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let size: usize = header
            .trim()
            .rsplit(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap_or(0);
        let mut buf = vec![0u8; size];
        reader.read_exact(&mut buf)?;
        let mut nl = [0u8; 1];
        reader.read_exact(&mut nl)?; // trailing newline
        bytes_read += size;
        if serde_json::from_slice::<serde_json::Value>(&buf).is_ok() {
            parsed += 1;
        }
    }
    writer.join().ok();
    child.wait()?;
    Ok((bytes_read, parsed))
}

fn main() -> anyhow::Result<()> {
    let mut a = std::env::args().skip(1);
    let num_files: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(20_000);
    let num_dirty: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    let root: PathBuf = std::env::temp_dir().join(format!(
        "cold_open_bench_{}_{}",
        num_files,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root)?;
    println!(
        "fixture: {}  ({} files, {} dirtied)\n",
        root.display(),
        num_files,
        num_dirty
    );

    // ---- Build fixture: write N records, commit to main (index == HEAD) ----
    let t = Instant::now();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "bench@scratch.md"]);
    git(&root, &["config", "user.name", "bench"]);
    git(&root, &["config", "core.fsmonitor", "false"]);
    for f in FOLDERS {
        std::fs::create_dir_all(root.join(f))?;
    }
    for i in 0..num_files {
        std::fs::write(root.join(rel_path(i)), sample_record(i))?;
    }
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "seed"]);
    println!("fixture build + commit: {:?}\n", t.elapsed());

    let repo = gix::open(&root)?;

    // ---- A. gix status, CLEAN corpus (fresh index) ----
    println!("A. gix status (index->worktree), CLEAN corpus, fresh index:");
    for run in 1..=3 {
        let (dt, flagged) = run_gix_status(&repo)?;
        let label = if run == 1 {
            "cold (in-process, warm OS cache)"
        } else {
            "warm"
        };
        println!("   run {run} ({label}): {dt:?} — {} flagged", flagged.len());
    }
    println!();

    // ---- B. gix status with `num_dirty` dirtied files + post-filter ----
    for i in 0..num_dirty.min(num_files) {
        // append a byte-level change that is also a semantic change
        let p = root.join(rel_path(i));
        let mut body = std::fs::read(&p)?;
        body.extend_from_slice(b"\n");
        // make it a real semantic edit too
        let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p)?)?;
        v["fields"]["Status"] = serde_json::Value::String("Edited".into());
        std::fs::write(&p, serde_json::to_vec_pretty(&v)?)?;
        let _ = body;
    }
    println!("B. gix status, {num_dirty} dirty file(s) (mostly-clean open):");
    let (dt, flagged) = run_gix_status(&repo)?;
    println!("   gix status: {dt:?} — {} flagged", flagged.len());
    // The real helper then reads only the flagged paths' blobs from main and
    // semantic-compares. Measure that disambiguation tail.
    let t = Instant::now();
    let mut confirmed = 0usize;
    for path in &flagged {
        let working = std::fs::read(root.join(path)).ok();
        let main_blob = Command::new("git")
            .current_dir(&root)
            .args(["cat-file", "-p", &format!("main:{path}")])
            .output()
            .ok()
            .map(|o| o.stdout);
        let w: Option<serde_json::Value> = working.and_then(|b| serde_json::from_slice(&b).ok());
        let m: Option<serde_json::Value> = main_blob.and_then(|b| serde_json::from_slice(&b).ok());
        if w != m {
            confirmed += 1;
        }
    }
    println!(
        "   + disambiguate {} flagged path(s) vs main: {:?} — {confirmed} truly unreviewed\n",
        flagged.len(),
        t.elapsed()
    );

    // ---- C. The "old sweep": read+parse all working files + all main blobs ----
    println!("C. folder_index twice-parse sweep (what DEV-10327 deletes):");
    let working_paths: Vec<PathBuf> = (0..num_files).map(|i| root.join(rel_path(i))).collect();

    // serial
    let t = Instant::now();
    let mut ok = 0usize;
    for p in &working_paths {
        if let Ok(b) = std::fs::read(p) {
            if serde_json::from_slice::<serde_json::Value>(&b).is_ok() {
                ok += 1;
            }
        }
    }
    let working_serial = t.elapsed();

    let t = Instant::now();
    let (main_bytes, main_parsed) = read_and_parse_all_main_blobs(&root)?;
    let main_read = t.elapsed();
    println!("   read+parse working (serial):       {working_serial:?} — {ok} parsed",);
    println!(
        "   read+parse main blobs (cat-file):  {main_read:?} — {main_parsed} parsed, {} MiB",
        main_bytes / (1024 * 1024)
    );

    // parallel working parse (give the sweep its best case)
    let t = Instant::now();
    let ok_par: usize = working_paths
        .par_iter()
        .filter(|p| {
            std::fs::read(p)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .is_some()
        })
        .count();
    let working_par = t.elapsed();
    println!("   read+parse working (rayon par):    {working_par:?} — {ok_par} parsed");

    let sweep_total_serial = working_serial + main_read;
    println!(
        "\n   => sweep total (serial working + main): {:?}",
        sweep_total_serial
    );

    println!("\n(cleanup: rm -rf {})", root.display());
    let _ = std::fs::remove_dir_all(&root);
    Ok(())
}
