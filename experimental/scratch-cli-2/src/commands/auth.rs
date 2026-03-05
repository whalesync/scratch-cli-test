use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use clap::{Args, Subcommand};

use crate::api::Client;
use crate::cli::Cli;
use crate::credentials;

#[derive(Args)]
pub struct AuthCommand {
    #[command(subcommand)]
    pub action: AuthAction,
}

#[derive(Subcommand)]
pub enum AuthAction {
    /// Authenticate with Scratch.md
    Login {
        /// Don't open browser automatically
        #[arg(long)]
        no_browser: bool,

        /// Override the auth server URL
        #[arg(long)]
        server: Option<String>,
    },
    /// Remove stored credentials
    Logout {
        /// Override the auth server URL
        #[arg(long)]
        server: Option<String>,
    },
    /// Show current authentication status
    Status {
        /// Override the auth server URL
        #[arg(long)]
        server: Option<String>,
    },
}

impl AuthCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            AuthAction::Login { no_browser, server } => run_login(cli, *no_browser, server.as_deref()),
            AuthAction::Logout { server } => run_logout(cli, server.as_deref()),
            AuthAction::Status { server } => run_status(cli, server.as_deref()),
        }
    }
}

fn resolve_server_url(cli: &Cli, server_override: Option<&str>) -> String {
    if let Some(url) = server_override {
        if !url.is_empty() {
            return url.to_string();
        }
    }

    let config = crate::config::load_config(
        &std::env::current_dir().unwrap_or_default(),
        cli.scratch_url.as_deref(),
    );
    if let Ok(cfg) = config {
        return cfg.scratch_server_url().to_string();
    }

    crate::config::DEFAULT_SCRATCH_SERVER_URL.to_string()
}

fn run_login(cli: &Cli, no_browser: bool, server_override: Option<&str>) -> Result<()> {
    let server_url = resolve_server_url(cli, server_override);

    // Check if already logged in
    if credentials::is_logged_in(&server_url) {
        let creds = credentials::load_credentials(&server_url)?;
        print!("You are already logged in to {}", server_url);
        if !creds.email.is_empty() {
            print!(" as {}", creds.email);
        }
        println!(".");
        println!("Run 'scratchmd auth logout' to log out first.");
        return Ok(());
    }

    let client = Client::new(&server_url, None, cli.verbose)?;

    println!();
    println!("Authenticating with Scratch.md...");
    println!();

    let init_resp = client.initiate_auth()?;
    if !init_resp.error.is_empty() {
        bail!("authentication error: {}", init_resp.error);
    }

    let verification_url_with_code = format!("{}?code={}", init_resp.verification_url, init_resp.user_code);

    // Display the user code in a box
    let inner_text = format!("Your authorization code is: {}", init_resp.user_code);
    let box_width: usize = 45;
    let total_padding = box_width.saturating_sub(inner_text.len());
    let left_padding = total_padding / 2;
    let right_padding = total_padding - left_padding;

    println!("{}", "┌─────────────────────────────────────────────┐");
    println!("│{:width$}│", "", width = box_width);
    println!(
        "│{}{}{}│",
        " ".repeat(left_padding),
        inner_text,
        " ".repeat(right_padding)
    );
    println!("│{:width$}│", "", width = box_width);
    println!("{}", "└─────────────────────────────────────────────┘");
    println!();
    println!("Visit: {}", verification_url_with_code);
    println!();

    // Try to open browser
    if !no_browser {
        println!("Opening browser...");
        if open_browser(&verification_url_with_code).is_err() {
            println!("Could not open browser automatically.");
            println!("Please open the URL above manually.");
        }
    }

    println!();
    println!("Waiting for authorization...");
    println!("(Code expires in {} seconds)", init_resp.expires_in);
    println!();

    // Poll for authorization
    let poll_interval = if init_resp.interval > 0 {
        Duration::from_secs(init_resp.interval)
    } else {
        Duration::from_secs(5)
    };
    let deadline = Instant::now() + Duration::from_secs(init_resp.expires_in);

    while Instant::now() < deadline {
        thread::sleep(poll_interval);

        let poll_resp = match client.poll_auth(&init_resp.polling_code) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Polling error: {}", e);
                continue;
            }
        };

        match poll_resp.status.as_str() {
            "approved" => {
                let creds = credentials::EnvironmentCredentials {
                    api_token: poll_resp.api_token,
                    email: poll_resp.user_email.clone(),
                    expires_at: poll_resp.token_expires_at.clone(),
                };
                credentials::save_credentials(&server_url, &creds)?;

                println!();
                println!("Authentication successful!");
                if !poll_resp.user_email.is_empty() {
                    println!("   Logged in as: {}", poll_resp.user_email);
                }
                if !poll_resp.token_expires_at.is_empty() {
                    println!("   Token expires: {}", poll_resp.token_expires_at);
                }
                println!();
                println!("You can now use scratchmd commands that require authentication.");
                return Ok(());
            }
            "denied" => bail!("authorization denied: {}", poll_resp.error),
            "expired" => bail!("authorization code expired. Please try again"),
            "pending" => print!("."),
            _ => {}
        }
    }

    bail!("authorization timed out. Please try again")
}

fn run_logout(cli: &Cli, server_override: Option<&str>) -> Result<()> {
    let server_url = resolve_server_url(cli, server_override);

    if !credentials::is_logged_in(&server_url) {
        println!("You are not logged in to {}.", server_url);
        return Ok(());
    }

    let creds = credentials::load_credentials(&server_url)?;
    let email = creds.email.clone();

    credentials::clear_credentials(&server_url)?;

    println!("Logged out from {} successfully.", server_url);
    if !email.is_empty() {
        println!("   Was logged in as: {}", email);
    }
    Ok(())
}

fn run_status(cli: &Cli, server_override: Option<&str>) -> Result<()> {
    let server_url = resolve_server_url(cli, server_override);
    let creds = credentials::load_credentials(&server_url)?;

    println!();
    println!("Server: {}", server_url);
    println!();

    if creds.api_token.is_empty() {
        println!("   Status: Not logged in");
        println!();
        println!("Run 'scratchmd auth login' to authenticate.");
    } else {
        println!("   Status: Logged in");
        if !creds.email.is_empty() {
            println!("   Email: {}", creds.email);
        }
        if !creds.expires_at.is_empty() {
            // Try to parse and show days until expiry
            if let Ok(expires) = chrono::DateTime::parse_from_rfc3339(&creds.expires_at) {
                let now = chrono::Utc::now();
                let days = (expires.signed_duration_since(now).num_hours()) / 24;
                if days < 0 {
                    println!("   Token has expired");
                } else if days == 0 {
                    println!("   Token expires today");
                } else if days == 1 {
                    println!("   Token expires in 1 day");
                } else {
                    println!("   Token expires in {} days", days);
                }
            } else {
                println!("   Token expires at {}", creds.expires_at);
            }
        }
        println!();
        println!("Run 'scratchmd auth logout' to log out.");
    }
    println!();

    Ok(())
}

fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", url])
            .spawn()?;
    }
    Ok(())
}
