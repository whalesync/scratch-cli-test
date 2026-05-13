#[path = "../shared/mod.rs"]
mod shared;

mod api;
mod commands;
mod config;
mod git_ops;

use anyhow::Context;
use clap::{Parser, Subcommand};

use api::{ApiClient, DEFAULT_SERVER_URL};
use commands::{
    auth, connections, files, index, linked, plan_publish, read_records, syncs, workspaces,
};
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
    /// Regenerate CLAUDE.md and .scratch/docs/ in the current workspace
    #[command(name = "generate-docs")]
    GenerateDocs {
        /// Workspace directory (default: current directory)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Get validation results for a single record as JSON
    #[command(name = "get-validation-results")]
    GetValidationResults {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative record path: <connection>/<folder>/<filename>
        #[arg(long)]
        record: String,
    },
    /// Get validation results for all records in a folder as JSON
    #[command(name = "get-folder-validation-results")]
    GetFolderValidationResults {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
    },
    /// Get filenames that have at least one error-level validation violation in a folder as JSON.
    /// Example: scratchmd get-filenames-with-errors --folder my-conn/posts --workspace .
    #[command(name = "get-filenames-with-errors")]
    GetFilenamesWithErrors {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
    },
    /// Get validation error/warning counts grouped by connection and folder as JSON.
    /// Returns an array of { connection, folder_path, errors, warnings }.
    /// Example: scratchmd get-validation-stats --workspace .
    #[command(name = "get-validation-stats")]
    GetValidationStats {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Get up to 20 validation results for a folder as JSON (for UI previews).
    /// Example: scratchmd get-folder-validation-sample --folder my-conn/posts --workspace .
    #[command(name = "get-folder-validation-sample")]
    GetFolderValidationSample {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
    },
    /// Print validation config loaded from validation.json files in the workspace
    #[command(name = "dump-validations")]
    DumpValidations {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Only inspect the named connection (case-sensitive)
        #[arg(long)]
        connection: Option<String>,
    },
    /// Populate (or refresh) the SQLite index for a single JSON-path column in a folder.
    /// Useful for testing field indexing without running a full read-records query.
    #[command(name = "index-field")]
    IndexField {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// JSON path to index (e.g. "fields.title" or "status")
        #[arg(long)]
        column: String,
        /// Print progress to stderr (base sync, discovery, per-batch counts, timing)
        #[arg(long)]
        debug: bool,
    },
    /// Remove a field column and its metadata from the folder index.
    /// Drops the <column>, <column>:mt, and <column>:sz columns.
    /// Outputs JSON: { column: "...", rows_cleared: N }
    #[command(name = "clear-column-index")]
    ClearColumnIndex {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// Column name to remove (e.g. "id" or "fields.status")
        #[arg(long)]
        column: String,
    },
    /// Clear the SQLite folder index for a specific folder: removes all data and
    /// dynamically-added field columns, resetting it to the core schema.
    /// Outputs JSON: { rows_cleared: N }
    #[command(name = "clear-folder-index")]
    ClearFolderIndex {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
    },
    /// Query paginated filenames from a folder's SQLite index with optional filters and sorting.
    /// Outputs a JSON object: { filenames, filtered_total, summary, parse_errors }.
    /// Example: scratchmd paginate-records --folder my-conn/posts --limit 100 --offset 0
    #[command(name = "paginate-records", alias = "read-records")]
    ReadRecords {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// Number of records to skip (default: 0)
        #[arg(long, default_value_t = 0)]
        offset: i64,
        /// Maximum records to return, 1–1000 (default: 100)
        #[arg(long, default_value_t = 100)]
        limit: i64,
        /// Column to sort by: "filename", "approvedChanges", "unapprovedChanges", or a JSON path
        #[arg(long, default_value = "filename")]
        sort_by: String,
        /// Sort direction: "asc" or "desc"
        #[arg(long, default_value = "asc")]
        sort_order: String,
        /// Filter expression as JSON. Repeatable.
        /// Examples: '{"op":"approvedChanges"}' '{"op":"eq","field":"fields.status","value":"draft"}'
        #[arg(long = "filter")]
        filters: Vec<String>,
        /// Override the SQLite database path (default: <workspace>/.scratchmd/<folder-slug>.db)
        #[arg(long)]
        db_path: Option<std::path::PathBuf>,
        /// Force a full re-scan of all files before querying
        #[arg(long)]
        reindex: bool,
        /// Check how many rows are stale without mutating the index; outputs { stale, total }
        #[arg(long)]
        check: bool,
        /// Print per-batch indexing progress to stderr
        #[arg(long)]
        debug: bool,
        /// Validate stale records on this page and return per-row errors
        #[arg(long)]
        validate: bool,
    },
    /// List filenames in a folder whose base index row is stale (new, changed, or deleted).
    /// Outputs a JSON array of filenames.
    #[command(name = "find-stale-files")]
    FindStaleFiles {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
    },
    /// List filenames in a folder whose indexed field column value is stale.
    /// If no --column is given, all non-core columns are checked.
    /// Outputs a JSON array of filenames.
    #[command(name = "find-column-stale-files")]
    FindColumnStaleFiles {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// Column(s) to check (may be repeated). Omit to check all non-core columns.
        #[arg(long = "column")]
        columns: Vec<String>,
    },
    /// Classify stale files into two sets: base_stale (working mtime changed, needs full reindex)
    /// and column_stale (base row valid, only field column values stale, working JSON only).
    /// Outputs JSON: { base_stale: [...], column_stale: [...] }
    #[command(name = "find-stale")]
    FindStale {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// Column(s) to check for staleness (may be repeated). Omit to check all.
        #[arg(long = "column")]
        columns: Vec<String>,
    },
    /// Fully reindex a folder: delete all rows, rebuild from all three versions, repopulate field columns.
    /// Outputs: { rows: N }
    #[command(name = "reindex-table")]
    ReindexTable {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long)]
        folder: String,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Reindex all folders in all connections of the workspace.
    /// Iterates each connection's subfolders and runs reindex-table for each.
    #[command(name = "reindex-workspace")]
    ReindexWorkspace {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Reindex specific files in a folder: reads all 3 versions, updates base row + all active columns.
    /// Accepts one or more --file arguments (filenames only, not paths).
    #[command(name = "reindex-files")]
    ReindexFiles {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long, allow_hyphen_values = true)]
        folder: String,
        /// Filename(s) to reindex (may be repeated)
        #[arg(long = "file", allow_hyphen_values = true)]
        files: Vec<String>,
        /// Also run validators and update has_errors / validation_results for the reindexed files
        #[arg(long)]
        validate: bool,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Reindex field column values for specific files using working-tree JSON only.
    /// Does NOT touch the base row (approvedChanges etc.) — use when only column values are stale.
    #[command(name = "reindex-files-columns")]
    ReindexFilesColumns {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder> (e.g. "my-conn/posts")
        #[arg(long, allow_hyphen_values = true)]
        folder: String,
        /// Filename(s) to reindex (may be repeated)
        #[arg(long = "file", allow_hyphen_values = true)]
        files: Vec<String>,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Run validation against a record without writing to the index.
    /// Designed for agent dry-runs. Accepts inline JSON overrides for the record,
    /// master record, validation.json, and schema.json — any combination.
    #[command(name = "validate-record")]
    ValidateRecord {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Folder path: <connection>/<folder> (e.g. "WEBFLOW - My Site/Blog Posts").
        /// Required when reading any source from disk.
        #[arg(long)]
        folder: Option<String>,
        /// Record filename(s) to read from the working copy. Repeatable.
        /// Mutually exclusive with --record.
        #[arg(long = "file")]
        files: Vec<String>,
        /// Inline record JSON. Mutually exclusive with --file.
        #[arg(long)]
        record: Option<String>,
        /// Inline master record JSON (overrides disk lookup for readonly checks).
        #[arg(long)]
        master: Option<String>,
        /// Inline validation.json content (JSON array, overrides disk).
        #[arg(long)]
        validation: Option<String>,
        /// Inline schema.json content (overrides disk).
        #[arg(long)]
        schema: Option<String>,
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
        Commands::GetValidationResults { workspace, record } => {
            index::get_validation_results_command(&workspace, &record)
        }
        Commands::GetFolderValidationResults { workspace, folder } => {
            index::get_folder_validation_results_command(&workspace, &folder)
        }
        Commands::GetFilenamesWithErrors { workspace, folder } => {
            index::get_filenames_with_errors_command(&workspace, &folder)
        }
        Commands::GetValidationStats { workspace } => {
            index::get_validation_stats_command(&workspace)
        }
        Commands::GetFolderValidationSample { workspace, folder } => {
            index::get_folder_validation_sample_command(&workspace, &folder)
        }
        Commands::IndexField {
            workspace,
            folder,
            column,
            debug,
        } => index::index_field_command(&workspace, &folder, &column, debug),
        Commands::ClearColumnIndex {
            workspace,
            folder,
            column,
        } => index::clear_column_index_command(&workspace, &folder, &column),
        Commands::ClearFolderIndex { workspace, folder } => {
            index::clear_folder_index_command(&workspace, &folder)
        }
        Commands::FindStaleFiles { workspace, folder } => {
            index::find_stale_files_command(&workspace, &folder)
        }
        Commands::FindColumnStaleFiles {
            workspace,
            folder,
            columns,
        } => index::find_column_stale_files_command(&workspace, &folder, &columns),
        Commands::FindStale {
            workspace,
            folder,
            columns,
        } => index::find_stale_command(&workspace, &folder, &columns),
        Commands::ReindexTable {
            workspace,
            folder,
            debug,
        } => index::reindex_table_command(&workspace, &folder, debug),
        Commands::ReindexWorkspace { workspace } => index::reindex_workspace_command(&workspace),
        Commands::ReindexFiles {
            workspace,
            folder,
            files,
            validate,
            debug,
        } => index::reindex_files_command(&workspace, &folder, &files, validate, debug),
        Commands::ReindexFilesColumns {
            workspace,
            folder,
            files,
            debug,
        } => index::reindex_files_columns_command(&workspace, &folder, &files, debug),
        Commands::DumpValidations {
            workspace,
            connection,
        } => index::dump_validations_command(&workspace, connection.as_deref()),
        Commands::ValidateRecord {
            workspace,
            folder,
            files,
            record,
            master,
            validation,
            schema,
        } => index::validate_record_command(
            &workspace,
            folder.as_deref(),
            &files,
            record.as_deref(),
            master.as_deref(),
            validation.as_deref(),
            schema.as_deref(),
        ),
        Commands::ReadRecords {
            workspace,
            folder,
            offset,
            limit,
            sort_by,
            sort_order,
            filters,
            db_path,
            reindex,
            check,
            debug,
            validate,
        } => read_records::run(
            &workspace,
            &folder,
            offset,
            limit,
            &sort_by,
            &sort_order,
            &filters,
            db_path.as_ref(),
            reindex,
            check,
            debug,
            validate,
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
