#[path = "../shared/mod.rs"]
mod shared;

mod api;
mod commands;
mod config;
mod git_ops;

use anyhow::Context;
use clap::{Parser, Subcommand};

use api::{ApiClient, DEFAULT_SERVER_URL};
use commands::{auth, connections, files, index, linked, plan_publish, syncs, workspaces};
use config::project_config;

#[derive(Parser)]
#[command(name = "scratchmd", version, about = "Scratch content management CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Override the Scratch server URL
    #[arg(long, global = true, env = "SCRATCH_URL")]
    scratch_url: Option<String>,

    /// Path to config file (default: scratchmd.config.yaml in current directory)
    #[arg(long, global = true)]
    config: Option<String>,

    /// Enable verbose output
    #[arg(long, short = 'v', global = true)]
    verbose: bool,

    /// Output as JSON
    #[arg(long, global = true)]
    json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage authentication
    Auth {
        /// Override the Scratch server URL (alias for global --scratch-url)
        #[arg(long)]
        server: Option<String>,
        #[command(subcommand)]
        command: auth::AuthCommands,
    },
    /// Manage workspaces
    Workspaces {
        #[command(subcommand)]
        command: workspaces::WorkspacesCommands,
    },
    /// Manage files (download / upload)
    Files {
        #[command(subcommand)]
        command: files::FilesCommands,
    },
    /// Manage connections
    Connections {
        /// Workspace ID (auto-detected from .scratchmd if not set)
        #[arg(long)]
        workspace: Option<String>,
        #[command(subcommand)]
        command: connections::ConnectionsCommands,
    },
    /// Manage linked tables
    Linked {
        /// Workspace ID (auto-detected from .scratchmd if not set)
        #[arg(long)]
        workspace: Option<String>,
        #[command(subcommand)]
        command: linked::LinkedCommands,
    },
    /// Manage syncs
    Syncs {
        /// Workspace ID (auto-detected from .scratchmd if not set)
        #[arg(long)]
        workspace: Option<String>,
        #[command(subcommand)]
        command: syncs::SyncsCommands,
    },
    /// Build a local publish plan by diffing dirty vs master
    #[command(name = "plan-publish")]
    PlanPublish {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Only include files matching this relative path (e.g. "connection/folder/file.json")
        #[arg(long)]
        filter: Option<String>,
    },
    /// Trigger server-side publish from the local publish plan
    #[command(name = "publish-from-git")]
    PublishFromGit {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Rebuild SQLite file index for the current workspace
    #[command(name = "build-index")]
    BuildIndex {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Print file index contents (for debugging)
    #[command(name = "dump-index")]
    DumpIndex {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Dump only the named connection (case-sensitive)
        #[arg(long)]
        connection: Option<String>,
    },
    /// Refresh the local record index for dirty worktrees
    #[command(name = "refresh-record-index", alias = "sync-record-index")]
    RefreshRecordIndex {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Only refresh the named connection (case-sensitive)
        #[arg(long)]
        connection: Option<String>,
        /// Refresh only this record path. Accepts absolute paths, workspace-relative
        /// '<connection>/<path>' values, or plain relative paths when the workspace has one connection.
        #[arg(long = "path")]
        paths: Vec<String>,
        /// Reconcile every record in the connection, not just changed candidates
        #[arg(long)]
        rebuild: bool,
    },
    /// List records that would be processed by refresh-record-index
    #[command(name = "list-stale-records")]
    ListStaleRecords {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Only inspect the named connection (case-sensitive)
        #[arg(long)]
        connection: Option<String>,
        /// Restrict inspection to this record path. Accepts absolute paths, workspace-relative
        /// '<connection>/<path>' values, or plain relative paths when the workspace has one connection.
        #[arg(long = "path")]
        paths: Vec<String>,
        /// Treat the run as a full rebuild when computing stale records
        #[arg(long)]
        rebuild: bool,
    },
    /// Regenerate CLAUDE.md and .scratch/docs/ in the current workspace
    #[command(name = "generate-docs")]
    GenerateDocs {
        /// Workspace directory (default: current directory)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
}

fn require_git() -> anyhow::Result<()> {
    match std::process::Command::new("git").arg("--version").output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(_) => anyhow::bail!(
            "git is installed but returned an error. Please check your git installation."
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("git is not installed. Please install git and try again.")
        }
        Err(e) => anyhow::bail!("failed to check for git: {e}"),
    }
}

fn build_client(server_url: &str) -> anyhow::Result<ApiClient> {
    ApiClient::from_credentials(server_url)
        .with_context(|| "Not authenticated. Run `scratchmd auth login` first.")
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    // Priority: --scratch-url / SCRATCH_URL  >  scratchmd.config.yaml  >  compiled default
    let server_url = cli
        .scratch_url
        .or_else(|| project_config::load_server_url(cli.config.as_deref()))
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());

    // All commands except Auth require git to be installed.
    if !matches!(cli.command, Commands::Auth { .. }) {
        if let Err(e) = require_git() {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }

    let result = match cli.command {
        Commands::Auth { command, server } => {
            let url = server.as_deref().unwrap_or(&server_url).to_string();
            auth::run(command, &url, cli.json).await
        }

        Commands::Workspaces { command } => workspaces::run(command, &server_url, cli.json).await,

        Commands::Files { command } => files::run(command, &server_url, cli.json).await,

        Commands::Connections { workspace, command } => match build_client(&server_url) {
            Ok(client) => connections::run(command, &client, workspace.as_deref(), cli.json).await,
            Err(e) => Err(e),
        },

        Commands::Linked { workspace, command } => match build_client(&server_url) {
            Ok(client) => linked::run(command, &client, workspace.as_deref(), cli.json).await,
            Err(e) => Err(e),
        },

        Commands::Syncs { workspace, command } => {
            // Local commands don't need an API client
            if matches!(
                command,
                syncs::SyncsCommands::ValidateLocal { .. } | syncs::SyncsCommands::RunLocal { .. }
            ) {
                syncs::run_local_cmd(command, cli.json)
            } else {
                match build_client(&server_url) {
                    Ok(client) => {
                        syncs::run(command, &client, workspace.as_deref(), cli.json).await
                    }
                    Err(e) => Err(e),
                }
            }
        }

        Commands::PlanPublish { workspace, filter } => {
            plan_publish::run(&workspace, filter.as_deref())
        }

        Commands::PublishFromGit { workspace } => match build_client(&server_url) {
            Ok(client) => plan_publish::run_publish_from_git(&workspace, &client).await,
            Err(e) => Err(e),
        },

        Commands::BuildIndex { workspace } => index::build_command(&workspace),
        Commands::DumpIndex {
            workspace,
            connection,
        } => index::dump_command(&workspace, connection.as_deref()),
        Commands::RefreshRecordIndex {
            workspace,
            connection,
            paths,
            rebuild,
        } => index::refresh_record_index_command(
            &workspace,
            connection.as_deref(),
            &paths,
            rebuild,
            cli.json,
        ),
        Commands::ListStaleRecords {
            workspace,
            connection,
            paths,
            rebuild,
        } => index::list_stale_records_command(
            &workspace,
            connection.as_deref(),
            &paths,
            rebuild,
            cli.json,
        ),
        Commands::GenerateDocs { workspace } => (|| -> anyhow::Result<()> {
            let wb_dir = commands::generate_docs::resolve_workspace_for_docs(&workspace)?;
            let name = wb_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            commands::generate_docs::write_docs(&wb_dir, &name)?;
            println!("Docs written to {}", wb_dir.display());
            Ok(())
        })(),
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
