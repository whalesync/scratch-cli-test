use std::path::Path;
use std::process::Command;

// Remote Git helpers isolate auth and transport-facing operations like clone,
// fetch, and push so they can change without touching local repo logic.

pub(crate) fn clone_bare(url: &str, target_dir: &Path, token: &str) -> anyhow::Result<()> {
    if let Some(parent) = target_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let auth = git_auth_args(token);
    let output = Command::new("git")
        .args(&auth)
        .args([
            "clone",
            "--bare",
            url,
            target_dir.to_str().unwrap_or_default(),
        ])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git clone --bare failed for {url}: {}", stderr.trim());
    }
    Ok(())
}

pub(crate) fn fetch_origin(bare_repo: &Path, token: &str) -> anyhow::Result<()> {
    let auth = git_auth_args(token);
    let output = Command::new("git")
        .arg(format!("--git-dir={}", bare_repo.display()))
        .args(&auth)
        .args(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "git fetch failed for {}: {}",
            bare_repo.display(),
            stderr.trim()
        );
    }
    Ok(())
}

pub(crate) fn force_push_origin_dirty(bare_repo: &Path, token: &str) -> anyhow::Result<()> {
    let auth = git_auth_args(token);
    let output = Command::new("git")
        .arg(format!("--git-dir={}", bare_repo.display()))
        .args(&auth)
        .args(["push", "--force", "origin", "refs/heads/dirty:dirty"])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git push --force failed: {}", stderr.trim());
    }
    Ok(())
}

fn git_auth_args(token: &str) -> [String; 2] {
    [
        "-c".to_string(),
        format!("http.extraHeader=Authorization: API-Token {}", token),
    ]
}
