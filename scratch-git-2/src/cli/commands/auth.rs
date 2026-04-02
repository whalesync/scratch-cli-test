use std::time::Duration;

use clap::Subcommand;
use tokio::time::sleep;

use crate::api::ApiClient;
use crate::config::credentials::{self, EnvCredentials};

#[derive(Subcommand)]
pub enum AuthCommands {
    /// Authenticate with Scratch.md (opens browser)
    Login {
        #[arg(long, help = "Don't open browser automatically")]
        no_browser: bool,
    },
    /// Remove stored credentials
    Logout,
    /// Show current authentication status
    Status,
}

pub async fn run(cmd: AuthCommands, server_url: &str) -> anyhow::Result<()> {
    match cmd {
        AuthCommands::Login { no_browser } => login(server_url, no_browser).await,
        AuthCommands::Logout => logout(server_url),
        AuthCommands::Status => status(server_url),
    }
}

async fn login(server_url: &str, no_browser: bool) -> anyhow::Result<()> {
    if credentials::is_logged_in(server_url) {
        let creds = credentials::get(server_url).unwrap();
        print!("Already logged in to {}", server_url);
        if !creds.email.is_empty() {
            print!(" as {}", creds.email);
        }
        println!(".\nRun `scratchmd auth logout` to log out first.");
        return Ok(());
    }

    println!("\nAuthenticating with Scratch.md...\n");

    let init = ApiClient::auth_initiate(server_url).await?;
    if !init.error.is_empty() {
        anyhow::bail!("Authentication error: {}", init.error);
    }

    let verify_url = format!("{}?code={}", init.verification_url, init.user_code);

    println!("Your authorization code is: {}", init.user_code);
    println!("\nVisit: {}\n", verify_url);

    if !no_browser {
        println!("Opening browser...");
        if let Err(e) = open::that(&verify_url) {
            eprintln!(
                "Could not open browser: {}. Please open the URL manually.",
                e
            );
        }
    }

    println!("\nWaiting for authorization...");

    let poll_secs = if init.interval > 0 { init.interval } else { 5 };
    let expire_secs = if init.expires_in > 0 {
        init.expires_in
    } else {
        300
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(expire_secs);

    loop {
        sleep(Duration::from_secs(poll_secs)).await;

        let poll = ApiClient::auth_poll(server_url, &init.polling_code).await?;
        match poll.status.as_str() {
            "approved" => {
                credentials::set(
                    server_url,
                    EnvCredentials {
                        api_token: poll.api_token,
                        email: poll.user_email.clone(),
                        expires_at: poll.token_expires_at,
                    },
                )?;
                println!("\nAuthentication successful!");
                if !poll.user_email.is_empty() {
                    println!("  Logged in as: {}", poll.user_email);
                }
                return Ok(());
            }
            "denied" => anyhow::bail!("Authorization denied: {}", poll.error),
            "expired" => anyhow::bail!("Authorization code expired. Please try again."),
            _ => {
                eprint!(".");
                if std::time::Instant::now() > deadline {
                    anyhow::bail!("Authorization timed out. Please try again.");
                }
            }
        }
    }
}

fn logout(server_url: &str) -> anyhow::Result<()> {
    if !credentials::is_logged_in(server_url) {
        println!("Not logged in to {}.", server_url);
        return Ok(());
    }
    let email = credentials::get(server_url)
        .map(|c| c.email)
        .unwrap_or_default();
    credentials::clear(server_url)?;
    print!("Logged out from {}", server_url);
    if !email.is_empty() {
        print!(" (was: {})", email);
    }
    println!(".");
    Ok(())
}

fn status(server_url: &str) -> anyhow::Result<()> {
    println!("\nServer: {}\n", server_url);
    match credentials::get(server_url) {
        Some(c) if !c.api_token.is_empty() => {
            println!("  Status: Logged in");
            if !c.email.is_empty() {
                println!("  Email:  {}", c.email);
            }
            if !c.expires_at.is_empty() {
                println!("  Token expires: {}", c.expires_at);
            }
            println!("\nRun `scratchmd auth logout` to log out.");
        }
        _ => {
            println!("  Status: Not logged in");
            println!("\nRun `scratchmd auth login` to authenticate.");
        }
    }
    println!();
    Ok(())
}
