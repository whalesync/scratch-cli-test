mod api_client;
mod color;
mod commands;
mod config;
mod workspace;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "scratch",
    version,
    about = "Scratch — a CLI for managing content across external services and git-backed workspaces.",
    long_about = "Scratch — a CLI for managing content across external services and git-backed workspaces.\n\n\
        Scratch syncs data between external services (Airtable, Webflow, etc.) and a local \
        git-backed workspace. Records are stored as JSON files organized in folders.\n\n\
        Most commands require an initialized workspace (run `scratch init` first). \
        Commands that talk to the API server need it running at the configured URL.",
    after_help = "Getting started:\n\
        \x20 scratch init <WORKBOOK_ID>     Create a workspace in the current directory\n\
        \x20 scratch pull                    Fetch records from external services\n\
        \x20 scratch status                  Check workspace and API connectivity\n\n\
        Offline commands (no API server needed):\n\
        \x20 scratch validate                Validate records against local schemas\n\
        \x20 scratch publish --dry-run       Preview a publish plan from local files\n\
        \x20 scratch sync run <ID> --dry-run Preview a sync from local files"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// URL of the Scratch API server (default: http://localhost:8000).
    /// Can also be set in .scratch/config.json or the SCRATCH_API_URL env var.
    /// Priority: --api-url flag > config file > env var > default.
    #[arg(long, env = "SCRATCH_API_URL")]
    api_url: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new workspace in the current directory.
    ///
    /// Creates a .scratch/ directory containing config.json and a schemas/ subdirectory.
    /// The workspace is linked to a workbook on the Scratch server.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch init wb_abc123\n\
            \x20 SCRATCH_ORG_ID=org_xyz scratch init wb_abc123\n\
            \x20 scratch init wb_abc123 --api-url https://scratch.example.com"
    )]
    Init {
        /// The workbook ID to link this workspace to (e.g. wb_abc123).
        /// Find this in the Scratch web UI or via the API.
        workbook_id: String,
    },

    /// Manage workspaces (create, list, delete).
    #[command(subcommand)]
    Workspace(WorkspaceCommands),

    /// Manage connections to external services (add, list, remove, test, tables).
    #[command(subcommand)]
    Connection(ConnectionCommands),

    /// Manage linked tables (list, add, remove).
    #[command(subcommand)]
    Table(TableCommands),

    /// Pull records from external services into the local workspace.
    ///
    /// Triggers a server-side pull from connected services (Airtable, Webflow, etc.),
    /// then downloads the resulting files as JSON to the local workspace directory.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch pull                         Pull all connections\n\
            \x20 scratch pull --connection conn_abc    Pull only one connection"
    )]
    Pull {
        /// Only pull from this connector account ID (e.g. conn_abc123).
        #[arg(long)]
        connection: Option<String>,
    },

    /// Push local workspace files to the Scratch server.
    ///
    /// Reads JSON files from the local workspace and uploads them to the
    /// server's git layer, where they appear as "dirty" changes.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch push                         Push all local files\n\
            \x20 scratch push --connection conn_abc    Push only files for one connection"
    )]
    Push {
        /// Only push files for this connector account ID.
        #[arg(long)]
        connection: Option<String>,
    },

    /// Manage syncs (create, list, show, delete, run).
    #[command(subcommand)]
    Sync(SyncCommands),

    /// Build and execute a publish plan to push changes to external services.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch publish                Publish all changes via the API server\n\
            \x20 scratch publish --dry-run      Preview the publish plan offline (no writes)"
    )]
    Publish {
        /// Build the publish plan locally and print a summary without executing it.
        #[arg(long)]
        dry_run: bool,
    },

    /// Validate workspace records against schemas and configured validators.
    ///
    /// JSON Schema validation works offline. Validators that compare against
    /// baselines (e.g. readonly_fields) connect to the API to fetch the
    /// main-branch state.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch validate                   Validate all records in the workspace\n\
            \x20 scratch validate --path posts       Validate only the posts/ folder"
    )]
    Validate {
        /// Folder path to validate, relative to the workspace root.
        #[arg(long)]
        path: Option<String>,
    },

    /// Show which files have been modified since the last pull/publish.
    Diff,

    /// Show workspace configuration and check API connectivity.
    Status,
}

#[derive(Subcommand)]
enum WorkspaceCommands {
    /// Create a new workspace on the server.
    Create {
        /// Name for the workspace.
        #[arg(long)]
        name: String,
    },
    /// List all workspaces.
    List,
    /// Delete a workspace.
    Delete {
        /// Workspace ID to delete.
        id: String,
    },
}

#[derive(Subcommand)]
enum ConnectionCommands {
    /// Add a new connection to an external service.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch connection add --service AIRTABLE --param apiKey=pat...\n\
            \x20 scratch connection add --service WORDPRESS --param endpoint=https://... --param username=admin --param password=secret"
    )]
    Add {
        /// Service type (e.g. AIRTABLE, WORDPRESS, WEBFLOW).
        #[arg(long)]
        service: String,
        /// Credential parameters as key=value pairs.
        #[arg(long = "param", value_parser = parse_key_val)]
        param: Vec<(String, String)>,
    },
    /// List connections for the current workspace.
    List,
    /// Remove a connection.
    Remove {
        /// Connection ID to remove.
        id: String,
    },
    /// Test a connection's credentials.
    Test {
        /// Connection ID to test.
        id: String,
    },
    /// Discover remote tables available from a connection.
    Tables {
        /// Connection ID to discover tables from.
        id: String,
    },
}

#[derive(Subcommand)]
enum TableCommands {
    /// List linked tables (data folders) in the current workspace.
    List,
    /// Link a table from a connection.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch table add conn_abc123 --table Posts\n\
            \x20 scratch table add conn_abc123 --table \"My Base / Tags\""
    )]
    Add {
        /// Connection ID to link the table from.
        conn_id: String,
        /// Table name to link (matched case-insensitively against discovered tables).
        #[arg(long)]
        table: String,
    },
    /// Unlink a table (remove data folder).
    Remove {
        /// Folder ID to remove.
        id: String,
    },
}

#[derive(Subcommand)]
enum SyncCommands {
    /// Create a new sync from a config file.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch sync create --name \"Tags → Categories\" --config sync.json"
    )]
    Create {
        /// Name for the sync.
        #[arg(long)]
        name: String,
        /// Path to sync config JSON file.
        #[arg(long)]
        config: String,
    },
    /// List all syncs.
    List,
    /// Show sync details.
    Show {
        /// Sync ID.
        id: String,
    },
    /// Delete a sync.
    Delete {
        /// Sync ID to delete.
        id: String,
    },
    /// Run a sync mapping.
    #[command(
        after_help = "Examples:\n\
            \x20 scratch sync run syn_abc123                       Run the sync on the server\n\
            \x20 scratch sync run syn_abc123 --dry-run              Preview what would change (offline)\n\
            \x20 scratch sync run --all                             Run all syncs"
    )]
    Run {
        /// The sync mapping ID to execute.
        #[arg(required_unless_present = "all")]
        id: Option<String>,

        /// Run all syncs.
        #[arg(long)]
        all: bool,

        /// Build the sync plan locally and print a summary without writing any files.
        #[arg(long)]
        dry_run: bool,

        /// Show the full content of transformed records (implies --dry-run behavior).
        #[arg(long)]
        preview: bool,
    },
}

/// Parse a key=value string for --param arguments.
fn parse_key_val(s: &str) -> Result<(String, String), String> {
    let pos = s
        .find('=')
        .ok_or_else(|| format!("invalid key=value: no `=` found in `{s}`"))?;
    Ok((s[..pos].to_string(), s[pos + 1..].to_string()))
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Init { workbook_id } => {
            commands::init::run(&workbook_id, cli.api_url.as_deref()).await
        }
        Commands::Workspace(cmd) => {
            let api_url = cli
                .api_url
                .as_deref()
                .unwrap_or("http://localhost:8000");
            match cmd {
                WorkspaceCommands::Create { name } => {
                    commands::workspace_cmd::create(&name, api_url).await
                }
                WorkspaceCommands::List => commands::workspace_cmd::list(api_url).await,
                WorkspaceCommands::Delete { id } => {
                    commands::workspace_cmd::delete(&id, api_url).await
                }
            }
        }
        Commands::Connection(cmd) => match cmd {
            ConnectionCommands::Add { service, param } => {
                commands::connection_cmd::add(&service, &param, cli.api_url.as_deref()).await
            }
            ConnectionCommands::List => {
                commands::connection_cmd::list(cli.api_url.as_deref()).await
            }
            ConnectionCommands::Remove { id } => {
                commands::connection_cmd::remove(&id, cli.api_url.as_deref()).await
            }
            ConnectionCommands::Test { id } => {
                commands::connection_cmd::test(&id, cli.api_url.as_deref()).await
            }
            ConnectionCommands::Tables { id } => {
                commands::connection_cmd::tables(&id, cli.api_url.as_deref()).await
            }
        },
        Commands::Table(cmd) => match cmd {
            TableCommands::List => commands::table_cmd::list(cli.api_url.as_deref()).await,
            TableCommands::Add { conn_id, table } => {
                commands::table_cmd::add(&conn_id, &table, cli.api_url.as_deref()).await
            }
            TableCommands::Remove { id } => {
                commands::table_cmd::remove(&id, cli.api_url.as_deref()).await
            }
        },
        Commands::Pull { connection } => {
            commands::pull::run(connection.as_deref(), cli.api_url.as_deref()).await
        }
        Commands::Push { connection } => {
            commands::push::run(connection.as_deref(), cli.api_url.as_deref()).await
        }
        Commands::Sync(cmd) => match cmd {
            SyncCommands::Create { name, config } => {
                commands::sync_cmd::create(&name, &config, cli.api_url.as_deref()).await
            }
            SyncCommands::List => commands::sync_cmd::list(cli.api_url.as_deref()).await,
            SyncCommands::Show { id } => {
                commands::sync_cmd::show(&id, cli.api_url.as_deref()).await
            }
            SyncCommands::Delete { id } => {
                commands::sync_cmd::delete(&id, cli.api_url.as_deref()).await
            }
            SyncCommands::Run {
                id,
                all,
                dry_run,
                preview,
            } => {
                if all {
                    commands::sync_cmd::run_all(cli.api_url.as_deref()).await
                } else if let Some(mapping_id) = id {
                    commands::sync_cmd::run(&mapping_id, dry_run, preview, cli.api_url.as_deref())
                        .await
                } else {
                    Err("Either provide a sync ID or use --all".to_string())
                }
            }
        },
        Commands::Publish { dry_run } => {
            commands::publish::run(dry_run, cli.api_url.as_deref()).await
        }
        Commands::Validate { path } => {
            commands::validate::run(path.as_deref(), cli.api_url.as_deref()).await
        }
        Commands::Diff => commands::diff::run(cli.api_url.as_deref()).await,
        Commands::Status => commands::status::run(cli.api_url.as_deref()).await,
    };

    if let Err(e) = result {
        eprintln!("{}Error:{} {e}", color::red(), color::reset());
        std::process::exit(1);
    }
}
