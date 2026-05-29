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
    auth, connections, files, index, linked, read_records, syncs, validation, workspaces,
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
    /// Regenerate AGENTS.md (+ CLAUDE.md symlink) and .scratch/docs/ in the current workspace
    #[command(name = "generate-docs")]
    GenerateDocs {
        /// Workspace directory (default: current directory)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Query paginated filenames from a folder's SQLite index with optional filters and sorting.
    /// Outputs a JSON object: { filenames, filtered_total, summary, parse_errors }.
    /// Example: scratchmd paginate-records --folder my-conn/posts --limit 100 --offset 0
    #[command(name = "paginate-records")]
    PaginateRecords {
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
    /// Manage the SQLite file index (build, inspect, reindex, find-stale, …)
    Index {
        #[command(subcommand)]
        command: IndexCommands,
    },
    /// Read validation results and run dry-run validation
    Validation {
        #[command(subcommand)]
        command: ValidationCommands,
    },
}

#[derive(Subcommand)]
enum IndexCommands {
    /// List filenames in a folder whose working-tree mtime/size no longer matches the
    /// index (covers new, modified, and deleted files). Outputs a JSON array.
    #[command(name = "find-stale-files")]
    FindStaleFiles {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
    },
    /// Given a set of columns, list files where at least one of those columns is stale.
    /// Columns outside the input set are ignored. Empty input = check all non-core columns.
    /// Outputs a JSON array of filenames.
    #[command(name = "find-column-stale-files")]
    FindColumnStaleFiles {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Column(s) to check (may be repeated). Omit to check all non-core columns.
        #[arg(long = "column")]
        columns: Vec<String>,
    },
    /// Classify stale files into two sets: base_stale (working mtime/size changed)
    /// and column_stale (base row valid, only field column values stale).
    /// Outputs JSON: { base_stale: [...], column_stale: [...] }
    #[command(name = "find-stale")]
    FindStale {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Column(s) to check for staleness (may be repeated). Omit to check all.
        #[arg(long = "column")]
        columns: Vec<String>,
    },
    /// Wipe + fully rebuild every folder's index in the workspace.
    #[command(name = "rebuild-all")]
    RebuildAll {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Wipe + fully rebuild one folder's index from all three trees.
    /// Outputs: { rows: N }
    #[command(name = "rebuild-folder")]
    RebuildFolder {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Smart, mtime-aware refresh of one folder's index. Skips files that are already
    /// fresh. With --validate, also runs validators for files where validation is stale
    /// and populates the problems table.
    /// Outputs JSON: { base_refreshed, columns_refreshed, validated? }
    #[command(name = "refresh-folder")]
    RefreshFolder {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Also run validators (smart-skip) and populate the problems table.
        #[arg(long)]
        validate: bool,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Incrementally update base row + columns for specific files (reads all 3 trees).
    /// Accepts one or more --file arguments (filenames only, not paths).
    /// Pass --validate to also run validators on the refreshed files.
    #[command(name = "refresh-files-full")]
    RefreshFilesFull {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long, allow_hyphen_values = true)]
        folder: String,
        /// Filename(s) to refresh (may be repeated)
        #[arg(long = "file", allow_hyphen_values = true)]
        files: Vec<String>,
        /// Also run validators and update has_errors / validation_results for the refreshed files
        #[arg(long)]
        validate: bool,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Incrementally update only column values for specific files (working tree only).
    /// Does NOT touch the base row — use when only column values are stale.
    #[command(name = "refresh-files-columns-only")]
    RefreshFilesColumnsOnly {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long, allow_hyphen_values = true)]
        folder: String,
        /// Filename(s) to refresh (may be repeated)
        #[arg(long = "file", allow_hyphen_values = true)]
        files: Vec<String>,
        /// Print per-batch progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Add a JSON-path column to a folder's index and populate it.
    #[command(name = "add-column")]
    AddColumn {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// JSON path to index (e.g. "fields.title" or "status")
        #[arg(long)]
        column: String,
        /// Print progress to stderr
        #[arg(long)]
        debug: bool,
    },
    /// Remove a field column (and its `:mt`/`:sz` siblings) from a folder.
    /// Outputs JSON: { column: "...", rows_cleared: N }
    #[command(name = "clear-column")]
    ClearColumn {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Column name to remove
        #[arg(long)]
        column: String,
    },
    /// Wipe a folder's index — removes all rows and dynamic columns, resetting to the
    /// core schema. Outputs JSON: { rows_cleared: N }
    #[command(name = "clear-folder")]
    ClearFolder {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
    },
}

#[derive(Subcommand)]
enum ValidationCommands {
    /// Validation problems for a single file.
    /// `--record` is workspace-relative: <connection>/<folder>/<filename>
    #[command(name = "get-file-problems")]
    GetFileProblems {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative record path: <connection>/<folder>/<filename>
        #[arg(long)]
        record: String,
    },
    /// Validation problems for every record in a folder.
    /// Pass --limit to cap result count for UI previews (returns the most severe rows first).
    #[command(name = "get-folder-problems")]
    GetFolderProblems {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Cap result count. Omit for unlimited.
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Filenames in a folder with ≥1 error-level violation.
    /// Output: { filenames, field_paths }. Pass --limit to cap the filenames list.
    #[command(name = "get-files-with-problems")]
    GetFilesWithProblems {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Workspace-relative folder path: <connection>/<folder>
        #[arg(long)]
        folder: String,
        /// Cap the filenames list. Omit for unlimited.
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Workspace-wide error/warning counts grouped by connection + folder.
    /// Returns an array of { connection, folder_path, errors, warnings, records }.
    #[command(name = "get-stats")]
    GetStats {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
    },
    /// Print the loaded validation.json config for the workspace.
    #[command(name = "dump-config")]
    DumpConfig {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Only inspect the named connection (case-sensitive)
        #[arg(long)]
        connection: Option<String>,
    },
    /// Run validators against a record WITHOUT writing to the index — designed for
    /// agent experimentation. Accepts inline JSON overrides for any combination of:
    /// the record, the master record, validation.json, and schema.json. To commit a
    /// config and populate the problems table, use `index refresh-folder --validate`.
    #[command(name = "dry-run")]
    DryRun {
        /// Workspace directory (default: auto-detected from CWD)
        #[arg(long, default_value = ".")]
        workspace: std::path::PathBuf,
        /// Folder path: <connection>/<folder>. Required when reading any source from disk.
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
    match shared::git_exec::git_command().arg("--version").output() {
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

        Commands::PaginateRecords {
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

        Commands::Index { command } => match command {
            IndexCommands::FindStaleFiles { workspace, folder } => {
                index::find_stale_files_command(&workspace, &folder)
            }
            IndexCommands::FindColumnStaleFiles {
                workspace,
                folder,
                columns,
            } => index::find_column_stale_files_command(&workspace, &folder, &columns),
            IndexCommands::FindStale {
                workspace,
                folder,
                columns,
            } => index::find_stale_command(&workspace, &folder, &columns),
            IndexCommands::RebuildAll { workspace } => index::rebuild_all_command(&workspace),
            IndexCommands::RebuildFolder {
                workspace,
                folder,
                debug,
            } => index::rebuild_folder_command(&workspace, &folder, debug),
            IndexCommands::RefreshFolder {
                workspace,
                folder,
                validate,
                debug,
            } => index::refresh_folder_command(&workspace, &folder, validate, debug),
            IndexCommands::RefreshFilesFull {
                workspace,
                folder,
                files,
                validate,
                debug,
            } => index::refresh_files_full_command(&workspace, &folder, &files, validate, debug),
            IndexCommands::RefreshFilesColumnsOnly {
                workspace,
                folder,
                files,
                debug,
            } => index::refresh_files_columns_only_command(&workspace, &folder, &files, debug),
            IndexCommands::AddColumn {
                workspace,
                folder,
                column,
                debug,
            } => index::add_column_command(&workspace, &folder, &column, debug),
            IndexCommands::ClearColumn {
                workspace,
                folder,
                column,
            } => index::clear_column_command(&workspace, &folder, &column),
            IndexCommands::ClearFolder { workspace, folder } => {
                index::clear_folder_command(&workspace, &folder)
            }
        },

        Commands::Validation { command } => match command {
            ValidationCommands::GetFileProblems { workspace, record } => {
                validation::get_file_problems_command(&workspace, &record)
            }
            ValidationCommands::GetFolderProblems {
                workspace,
                folder,
                limit,
            } => validation::get_folder_problems_command(&workspace, &folder, limit),
            ValidationCommands::GetFilesWithProblems {
                workspace,
                folder,
                limit,
            } => validation::get_files_with_problems_command(&workspace, &folder, limit),
            ValidationCommands::GetStats { workspace } => validation::get_stats_command(&workspace),
            ValidationCommands::DumpConfig {
                workspace,
                connection,
            } => validation::dump_config_command(&workspace, connection.as_deref()),
            ValidationCommands::DryRun {
                workspace,
                folder,
                files,
                record,
                master,
                validation: validation_json,
                schema,
            } => validation::dry_run_command(
                &workspace,
                folder.as_deref(),
                &files,
                record.as_deref(),
                master.as_deref(),
                validation_json.as_deref(),
                schema.as_deref(),
            ),
        },

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
        // Flush stdout before the hard exit: when stdout is piped (tests,
        // desktop UI, CI logs), Rust's stdout uses a fully buffered writer
        // and `process::exit` skips destructors. Without this any JSON the
        // command already println'd in an error path (e.g. publish's
        // `failedConnections` payload printed before `anyhow::bail!`) would
        // be lost from the pipe.
        use std::io::Write;
        let _ = std::io::stdout().flush();
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
