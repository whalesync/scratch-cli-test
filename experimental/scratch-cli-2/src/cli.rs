use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::commands;

#[derive(Parser)]
#[command(
    name = "scratchmd",
    version,
    about = "Command-line tool for Scratch.md",
    long_about = r#"scratchmd is the command-line tool for Scratch.md.

══════════════════════════════════════════════════════════════════════════════
                              AUTHENTICATION
══════════════════════════════════════════════════════════════════════════════

  auth login                     Authenticate with Scratch.md
  auth logout                    End current session
  auth status                    Show current auth state

══════════════════════════════════════════════════════════════════════════════
                                WORKBOOKS
══════════════════════════════════════════════════════════════════════════════

  workbooks list                 List all workbooks
  workbooks create               Create a new workbook
  workbooks show <id>            Show workbook details
  workbooks delete <id>          Delete a workbook
  workbooks init <id>            Clone workbook files to local directory

══════════════════════════════════════════════════════════════════════════════
                                  FILES
══════════════════════════════════════════════════════════════════════════════

  files download                 Download remote changes and merge locally
  files upload                   Upload local changes to the server

══════════════════════════════════════════════════════════════════════════════
                               CONNECTIONS
══════════════════════════════════════════════════════════════════════════════

  connections list               List all connections in the workbook
  connections add                Authorize a new connection
  connections show <id>          Show connection details
  connections remove <id>        Delete a connection

══════════════════════════════════════════════════════════════════════════════
                              LINKED TABLES
══════════════════════════════════════════════════════════════════════════════

  linked available               List available tables from connections
  linked list                    List linked tables in a workbook
  linked add                     Link a new table to a workbook
  linked remove [id]             Unlink a table from a workbook
  linked show [id]               Show linked table details
  linked pull [id]               Pull CRM changes into the workbook
  linked publish [id]            Publish workbook changes to the CRM

══════════════════════════════════════════════════════════════════════════════
                                 SYNCS
══════════════════════════════════════════════════════════════════════════════

  syncs list                     List sync configurations
  syncs show <id>                Show sync details
  syncs create                   Create a new sync configuration
  syncs update <id>              Update a sync configuration
  syncs delete <id>              Delete a sync
  syncs run <id>                 Execute a sync"#
)]
pub struct Cli {
    /// Override scratch server URL
    #[arg(long)]
    pub scratch_url: Option<String>,

    /// Config file path (default: .scratchmd.config.yaml)
    #[arg(long)]
    pub config: Option<PathBuf>,

    /// Enable verbose output
    #[arg(short, long)]
    pub verbose: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Authentication commands
    Auth(commands::auth::AuthCommand),
    /// Workbook management
    Workbooks(commands::workbooks::WorkbooksCommand),
    /// File sync operations
    Files(commands::files::FilesCommand),
    /// Connection management
    Connections(commands::connections::ConnectionsCommand),
    /// Linked table management
    Linked(commands::linked::LinkedCommand),
    /// Sync configuration management
    Syncs(commands::syncs::SyncsCommand),
}

impl Cli {
    pub fn run(&self) -> Result<()> {
        match &self.command {
            Command::Auth(cmd) => cmd.run(self),
            Command::Workbooks(cmd) => cmd.run(self),
            Command::Files(cmd) => cmd.run(self),
            Command::Connections(cmd) => cmd.run(self),
            Command::Linked(cmd) => cmd.run(self),
            Command::Syncs(cmd) => cmd.run(self),
        }
    }
}
