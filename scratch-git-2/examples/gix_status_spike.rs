// Spike: time `gix::Repository::status(...)` against an existing dirty worktree
// to validate the diff-detection plan in
// docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md.
//
// Usage: cargo run --example gix_status_spike --release -- <worktree-path>

use std::path::PathBuf;
use std::time::Instant;

use gix::bstr::BString;

fn main() -> anyhow::Result<()> {
    let path: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("usage: gix_status_spike <worktree-path>"))?;

    println!("Opening: {}", path.display());
    let t0 = Instant::now();
    let repo = gix::open(&path)?;
    println!("  gix::open: {:?}", t0.elapsed());

    for run in 1..=3 {
        let label = if run == 1 { "cold" } else { "warm" };
        let t = Instant::now();
        let platform = repo.status(gix::progress::Discard)?;
        let iter = platform.into_iter(Vec::<BString>::new())?;
        let mut total = 0usize;
        let mut changed = 0usize;
        let mut errs = 0usize;
        for item in iter {
            match item {
                Ok(_) => {
                    total += 1;
                    changed += 1;
                }
                Err(_) => errs += 1,
            }
        }
        println!(
            "  run {} ({}): {:?} — {} reported items ({} changed, {} errs)",
            run,
            label,
            t.elapsed(),
            total,
            changed,
            errs
        );
    }

    Ok(())
}
