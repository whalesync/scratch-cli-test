use anyhow::Result;
use clap::Parser;

mod api;
mod cli;
mod commands;
mod config;
mod credentials;
mod merge;

fn main() -> Result<()> {
    let cli = cli::Cli::parse();
    cli.run()
}
