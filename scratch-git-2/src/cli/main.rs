#[path = "../shared/mod.rs"]
mod shared;

mod api;
mod commands;
mod config;

use anyhow::Context;
use clap::{Parser, Subcommand};

use api::{ApiClient, DEFAULT_SERVER_URL};
use commands::{auth, connections, files, linked, syncs, workspaces};

#[derive(Parser)]
#[command(
    name = "scratchmd2",
    version,
    about = "Scratch content management CLI (v2)"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Override the Scratch server URL
    #[arg(long, global = true, env = "SCRATCH_URL")]
    scratch_url: Option<String>,

    /// Output as JSON
    #[arg(long, global = true)]
    json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage authentication
    Auth {
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
}

fn build_client(server_url: &str) -> anyhow::Result<ApiClient> {
    ApiClient::from_credentials(server_url)
        .with_context(|| "Not authenticated. Run `scratchmd2 auth login` first.")
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let server_url = cli.scratch_url.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());

    let result = match cli.command {
        Commands::Auth { command } => auth::run(command, &server_url).await,

        Commands::Workspaces { command } => {
            workspaces::run(command, &server_url, cli.json).await
        }

        Commands::Files { command } => {
            files::run(command, &server_url, cli.json).await
        }

        Commands::Connections { workspace, command } => match build_client(&server_url) {
            Ok(client) => connections::run(command, &client, workspace.as_deref(), cli.json).await,
            Err(e) => Err(e),
        },

        Commands::Linked { workspace, command } => match build_client(&server_url) {
            Ok(client) => linked::run(command, &client, workspace.as_deref(), cli.json).await,
            Err(e) => Err(e),
        },

        Commands::Syncs { workspace, command } => match build_client(&server_url) {
            Ok(client) => syncs::run(command, &client, workspace.as_deref(), cli.json).await,
            Err(e) => Err(e),
        },
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
