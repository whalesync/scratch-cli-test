use std::collections::HashMap;

use anyhow::{bail, Result};
use clap::{Args, Subcommand};
use dialoguer::{Input, Password, Select};

use crate::cli::Cli;
use crate::commands::helpers::*;

#[derive(Args)]
pub struct ConnectionsCommand {
    #[command(subcommand)]
    pub action: ConnectionsAction,

    /// Override workbook auto-detection
    #[arg(long)]
    pub workbook: Option<String>,
}

#[derive(Subcommand)]
pub enum ConnectionsAction {
    /// List all connections in the workbook
    List {
        #[arg(long)]
        json: bool,
    },
    /// Authorize a new connection
    Add {
        #[arg(long)]
        service: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        param: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show connection details
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a connection
    Remove {
        id: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
}

struct AuthField {
    key: &'static str,
    display_name: &'static str,
    description: &'static str,
    sensitive: bool,
}

fn service_auth_config() -> Vec<(&'static str, Vec<AuthField>)> {
    vec![
        ("AIRTABLE", vec![
            AuthField { key: "apiKey", display_name: "API Key", description: "Your Airtable personal access token", sensitive: true },
        ]),
        ("WEBFLOW", vec![
            AuthField { key: "apiKey", display_name: "API Key", description: "Your Webflow API token", sensitive: true },
        ]),
        ("AUDIENCEFUL", vec![
            AuthField { key: "apiKey", display_name: "API Key", description: "Your Audienceful API key", sensitive: true },
        ]),
        ("SHOPIFY", vec![
            AuthField { key: "shopDomain", display_name: "Shop Domain", description: "Your Shopify store (e.g. my-store or my-store.myshopify.com)", sensitive: false },
            AuthField { key: "apiKey", display_name: "API Key", description: "Your Shopify Admin API access token", sensitive: true },
        ]),
        ("MOCO", vec![
            AuthField { key: "domain", display_name: "Moco Domain", description: "Your Moco subdomain (e.g. yourcompany for yourcompany.mocoapp.com)", sensitive: false },
            AuthField { key: "apiKey", display_name: "API Key", description: "Your Moco API key", sensitive: true },
        ]),
        ("WORDPRESS", vec![
            AuthField { key: "endpoint", display_name: "WordPress URL", description: "The URL of your WordPress site (e.g. https://example.com)", sensitive: false },
            AuthField { key: "username", display_name: "Username", description: "Your WordPress account username", sensitive: false },
            AuthField { key: "password", display_name: "Application Password", description: "Your WordPress application password (generate in Users > Profile)", sensitive: true },
        ]),
        ("POSTGRES", vec![
            AuthField { key: "connectionString", display_name: "Connection String", description: "PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)", sensitive: true },
        ]),
        ("SUPABASE", vec![
            AuthField { key: "connectionString", display_name: "Connection String", description: "Supabase connection string (find in Settings > Database > Connection string)", sensitive: true },
        ]),
    ]
}

fn supported_services() -> Vec<&'static str> {
    vec!["AIRTABLE", "WEBFLOW", "SHOPIFY", "MOCO", "AUDIENCEFUL", "WORDPRESS", "POSTGRES", "SUPABASE"]
}

fn parse_params(raw: &[String]) -> Result<HashMap<String, String>> {
    let mut params = HashMap::new();
    for p in raw {
        let parts: Vec<&str> = p.splitn(2, '=').collect();
        if parts.len() != 2 {
            bail!("invalid --param format {:?}, expected key=value", p);
        }
        params.insert(parts[0].to_string(), parts[1].to_string());
    }
    Ok(params)
}

impl ConnectionsCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            ConnectionsAction::List { json } => run_list(cli, self.workbook.as_deref(), *json),
            ConnectionsAction::Add {
                service,
                name,
                param,
                json,
            } => run_add(cli, self.workbook.as_deref(), service.as_deref(), name.as_deref(), param, *json),
            ConnectionsAction::Show { id, json } => run_show(cli, self.workbook.as_deref(), id, *json),
            ConnectionsAction::Remove { id, yes, json } => run_remove(cli, self.workbook.as_deref(), id, *yes, *json),
        }
    }
}

fn run_list(cli: &Cli, workbook_flag: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let connections = client.list_connections(&workbook_id)?;

    if json_output {
        return print_json(&connections);
    }

    if connections.is_empty() {
        println!("No connections found in this workbook.");
        println!();
        println!("Add a connection with: scratchmd connections add");
        return Ok(());
    }

    println!();
    println!(
        "  {:<36}  {:<14}  {:<20}  {:<8}  {}",
        "ID", "SERVICE", "NAME", "HEALTH", "CREATED"
    );
    println!(
        "  {:<36}  {:<14}  {:<20}  {:<8}  {}",
        "----", "-------", "----", "------", "-------"
    );
    for c in &connections {
        let health = c.health_status.as_deref().unwrap_or("-");
        let created = if c.created_at.len() > 10 {
            &c.created_at[..10]
        } else {
            &c.created_at
        };
        let name = if c.display_name.len() > 20 {
            format!("{}...", &c.display_name[..17])
        } else {
            c.display_name.clone()
        };
        println!(
            "  {:<36}  {:<14}  {:<20}  {:<8}  {}",
            c.id, c.service, name, health, created
        );
    }
    println!();

    Ok(())
}

fn run_add(
    cli: &Cli,
    workbook_flag: Option<&str>,
    service: Option<&str>,
    name: Option<&str>,
    raw_params: &[String],
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;

    if let (Some(svc), true) = (service, !raw_params.is_empty()) {
        // Non-interactive mode
        let svc = svc.to_uppercase();
        let params = parse_params(raw_params)?;

        let configs = service_auth_config();
        if let Some((_, fields)) = configs.iter().find(|(s, _)| *s == svc) {
            let missing: Vec<_> = fields
                .iter()
                .filter(|f| !params.contains_key(f.key))
                .map(|f| format!("{} ({})", f.key, f.display_name))
                .collect();
            if !missing.is_empty() {
                bail!("missing required params for {}: {}", svc, missing.join(", "));
            }
        }

        let result = client.create_connection(
            &workbook_id,
            &svc,
            name,
            params,
        )?;

        if json_output {
            return print_json(&result);
        }
        println!("\nConnection '{}' created successfully.", result.display_name);
        println!("  ID:      {}", result.id);
        println!("  Service: {}", result.service);
        if let Some(ref h) = result.health_status {
            println!("  Health:  {}", h);
        }
        println!();
        return Ok(());
    }

    // Interactive mode
    let services = supported_services();
    let selection = Select::new()
        .with_prompt("Select a service")
        .items(&services)
        .interact()?;
    let selected_service = services[selection];

    let configs = service_auth_config();
    let (_, fields) = configs
        .iter()
        .find(|(s, _)| *s == selected_service)
        .ok_or_else(|| anyhow::anyhow!("unknown service {:?}", selected_service))?;

    let mut params = HashMap::new();
    for field in fields {
        let value = if field.sensitive {
            Password::new()
                .with_prompt(format!("{} ({})", field.display_name, field.description))
                .interact()?
        } else {
            Input::<String>::new()
                .with_prompt(format!("{} ({})", field.display_name, field.description))
                .interact_text()?
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            bail!("{} cannot be empty", field.display_name);
        }
        params.insert(field.key.to_string(), value);
    }

    let lower = selected_service.to_lowercase();
    let default_name = format!("{}{}", &lower[..1].to_uppercase(), &lower[1..]);
    let display_name: String = Input::new()
        .with_prompt("Display name")
        .default(default_name.clone())
        .interact_text()?;
    let display_name = if display_name.is_empty() {
        default_name
    } else {
        display_name
    };

    let result = client.create_connection(
        &workbook_id,
        selected_service,
        Some(&display_name),
        params,
    )?;

    if json_output {
        return print_json(&result);
    }
    println!("\nConnection '{}' created successfully.", result.display_name);
    println!("  ID:      {}", result.id);
    println!("  Service: {}", result.service);
    if let Some(ref h) = result.health_status {
        println!("  Health:  {}", h);
    }
    println!();
    Ok(())
}

fn run_show(cli: &Cli, workbook_flag: Option<&str>, id: &str, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let connection = client.get_connection(&workbook_id, id)?;

    if json_output {
        return print_json(&connection);
    }

    let health = connection.health_status.as_deref().unwrap_or("-");

    println!();
    println!("  Name:    {}", connection.display_name);
    println!("  ID:      {}", connection.id);
    println!("  Service: {}", connection.service);
    println!("  Auth:    {}", connection.auth_type);
    println!("  Health:  {}", health);
    if let Some(ref msg) = connection.health_status_message {
        if !msg.is_empty() {
            println!("  Message: {}", msg);
        }
    }
    println!("  Created: {}", connection.created_at);
    println!("  Updated: {}", connection.updated_at);
    println!();

    Ok(())
}

fn run_remove(cli: &Cli, workbook_flag: Option<&str>, id: &str, yes: bool, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let connection = client.get_connection(&workbook_id, id)?;

    if !yes && !json_output {
        if !confirm(&format!(
            "Are you sure you want to delete connection \"{}\" ({})? [y/N] ",
            connection.display_name, connection.id
        ))? {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_connection(&workbook_id, id)?;

    if json_output {
        return print_json(&serde_json::json!({
            "success": true,
            "id": connection.id,
            "displayName": connection.display_name,
        }));
    }

    println!(
        "Connection \"{}\" deleted successfully.",
        connection.display_name
    );
    Ok(())
}
