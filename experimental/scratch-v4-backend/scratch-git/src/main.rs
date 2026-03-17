use clap::{Parser, Subcommand};

mod commands;
mod error;
mod git;
mod server;

pub use error::{Error, Result};

#[derive(Parser)]
#[command(name = "scratchmdv4", about = "Scratch engine — git backend and CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize a bare git repo at the given path (master + dirty branches)
    InitRepo(commands::init_repo::Args),

    /// Upsert files into the master branch of a repo (reads ndjson from stdin)
    UpsertFiles(commands::upsert_files::Args),

    /// Start the HTTP server (custom API + git http-backend proxy)
    Serve(commands::serve::Args),

    /// Clone a workbook from the API server to a local worktree structure
    Pull(commands::pull::Args),

    /// Fast-forward the dirty branch to master (preparation for JSON-aware rebase)
    RebaseDirty(commands::rebase_dirty::Args),

    /// Write CLAUDE.md and .scratch/docs/ for a pulled workspace
    GenerateDocs(commands::generate_docs::Args),

    /// Apply sync configs to local materialized worktrees
    RunSync(commands::run_sync::Args),

    /// Commit dirty worktrees and push to remote bare repos
    Push(commands::push::Args),
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("scratchmd=info".parse().unwrap()),
        )
        .init();

    let cli = Cli::parse();

    let result = match cli.command {
        Command::InitRepo(args) => commands::init_repo::run(args).await,
        Command::UpsertFiles(args) => commands::upsert_files::run(args).await,
        Command::Serve(args) => commands::serve::run(args).await,
        Command::Pull(args) => commands::pull::run(args).await,
        Command::RebaseDirty(args) => commands::rebase_dirty::run(args).await,
        Command::GenerateDocs(args) => commands::generate_docs::run(args).await,
        Command::RunSync(args) => commands::run_sync::run(args).await,
        Command::Push(args) => commands::push::run(args).await,
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
