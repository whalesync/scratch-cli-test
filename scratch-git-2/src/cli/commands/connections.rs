use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use clap::Subcommand;

use crate::api::{ApiClient, Connection, CreateConnectionRequest};
use crate::config;

/// Known service credential fields (non-interactive validation).
struct AuthField {
    key: &'static str,
    display_name: &'static str,
    required: bool,
}

fn service_auth_fields(service: &str) -> Option<Vec<AuthField>> {
    match service {
        "WEBFLOW" => Some(vec![AuthField {
            key: "apiKey",
            display_name: "API Key",
            required: true,
        }]),
        "AUDIENCEFUL" => Some(vec![AuthField {
            key: "apiKey",
            display_name: "API Key",
            required: true,
        }]),
        "SHOPIFY" => Some(vec![
            AuthField {
                key: "shopDomain",
                display_name: "Shop Domain",
                required: true,
            },
            AuthField {
                key: "apiKey",
                display_name: "API Key",
                required: true,
            },
        ]),
        "MOCO" => Some(vec![
            AuthField {
                key: "domain",
                display_name: "Moco Domain",
                required: true,
            },
            AuthField {
                key: "apiKey",
                display_name: "API Key",
                required: true,
            },
        ]),
        "WORDPRESS" => Some(vec![
            AuthField {
                key: "endpoint",
                display_name: "WordPress URL",
                required: true,
            },
            AuthField {
                key: "username",
                display_name: "Username",
                required: true,
            },
            AuthField {
                key: "password",
                display_name: "Application Password",
                required: true,
            },
        ]),
        "AIRTABLE" => Some(vec![AuthField {
            key: "apiKey",
            display_name: "API Key",
            required: true,
        }]),
        "POSTGRES" => Some(vec![AuthField {
            key: "connectionString",
            display_name: "Connection String",
            required: true,
        }]),
        "SUPABASE" => Some(vec![AuthField {
            key: "connectionString",
            display_name: "Connection String",
            required: true,
        }]),
        "PIPEDRIVE" => Some(vec![AuthField {
            key: "apiKey",
            display_name: "API Key",
            required: true,
        }]),
        "ATTIO" => Some(vec![AuthField {
            key: "apiKey",
            display_name: "Access Token",
            required: true,
        }]),
        _ => None,
    }
}

#[derive(Subcommand)]
pub enum ConnectionsCommands {
    /// List all connections in the workspace
    List,
    /// Authorize a new connection
    Add {
        /// Service type (AIRTABLE, WEBFLOW, SHOPIFY, MOCO, AUDIENCEFUL, WORDPRESS, POSTGRES, SUPABASE, PIPEDRIVE, ATTIO)
        #[arg(long)]
        service: String,
        /// Credential parameter as key=value (repeatable)
        #[arg(long = "param")]
        params: Vec<String>,
        /// Display name for the connection
        #[arg(long, default_value = "")]
        name: String,
    },
    /// Show connection details
    Show {
        /// Connection ID
        id: String,
    },
    /// Delete a connection
    Remove {
        /// Connection ID
        id: String,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
}

pub async fn run(
    cmd: ConnectionsCommands,
    client: &ApiClient,
    workspace: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    let workbook_id = config::resolve_workspace_id(workspace)?;
    match cmd {
        ConnectionsCommands::List => list(client, &workbook_id, json).await,
        ConnectionsCommands::Add {
            service,
            params,
            name,
        } => add(client, &workbook_id, &service, &params, &name, json).await,
        ConnectionsCommands::Show { id } => show(client, &workbook_id, &id, json).await,
        ConnectionsCommands::Remove { id, yes } => {
            remove(client, &workbook_id, &id, yes, json).await
        }
    }
}

async fn list(client: &ApiClient, workbook_id: &str, json: bool) -> anyhow::Result<()> {
    let connections = client.list_connections(workbook_id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&connections)?);
        return Ok(());
    }

    if connections.is_empty() {
        println!("No connections found in this workspace.");
        println!();
        println!("Add a connection with: scratchmd connections add --service AIRTABLE --param apiKey=<token>");
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

fn parse_params(raw: &[String]) -> anyhow::Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for p in raw {
        let (k, v) = p
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("invalid --param format {:?}, expected key=value", p))?;
        map.insert(k.to_string(), v.to_string());
    }
    Ok(map)
}

async fn add(
    client: &ApiClient,
    workbook_id: &str,
    service: &str,
    raw_params: &[String],
    name: &str,
    json: bool,
) -> anyhow::Result<()> {
    let service = service.to_uppercase();
    let params = parse_params(raw_params)?;

    if params.is_empty() {
        anyhow::bail!(
            "No credentials provided. Use --param key=value for each credential field.\n\
             Example: scratchmd connections add --service AIRTABLE --param apiKey=<token>"
        );
    }

    // Validate required fields if service is known
    if let Some(fields) = service_auth_fields(&service) {
        let missing: Vec<&str> = fields
            .iter()
            .filter(|f| f.required && !params.contains_key(f.key))
            .map(|f| f.display_name)
            .collect();
        if !missing.is_empty() {
            anyhow::bail!(
                "Missing required params for {}: {}",
                service,
                missing.join(", ")
            );
        }
    }

    let display_name = if name.is_empty() {
        let lower = service.to_lowercase();
        let mut chars = lower.chars();
        match chars.next() {
            None => String::new(),
            Some(c) => c.to_uppercase().to_string() + chars.as_str(),
        }
    } else {
        name.to_string()
    };

    let req = CreateConnectionRequest {
        service,
        display_name,
        user_provided_params: params,
    };

    let result = client.create_connection(workbook_id, &req).await?;
    print_connection_created(&result, json)
}

fn print_connection_created(c: &Connection, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(c)?);
        return Ok(());
    }
    println!("\nConnection '{}' created successfully.", c.display_name);
    println!("  ID:      {}", c.id);
    println!("  Service: {}", c.service);
    if let Some(h) = &c.health_status {
        println!("  Health:  {}", h);
    }
    if let Some(msg) = &c.health_status_message {
        if !msg.is_empty() {
            println!("  Message: {}", msg);
        }
    }
    println!();
    Ok(())
}

async fn show(client: &ApiClient, workbook_id: &str, id: &str, json: bool) -> anyhow::Result<()> {
    let c = client.get_connection(workbook_id, id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&c)?);
        return Ok(());
    }

    println!();
    println!("  Name:    {}", c.display_name);
    println!("  ID:      {}", c.id);
    println!("  Service: {}", c.service);
    println!("  Auth:    {}", c.auth_type);
    println!("  Health:  {}", c.health_status.as_deref().unwrap_or("-"));
    if let Some(msg) = &c.health_status_message {
        if !msg.is_empty() {
            println!("  Message: {}", msg);
        }
    }
    println!("  Created: {}", c.created_at);
    println!("  Updated: {}", c.updated_at);
    println!();
    Ok(())
}

async fn remove(
    client: &ApiClient,
    workbook_id: &str,
    id: &str,
    yes: bool,
    json: bool,
) -> anyhow::Result<()> {
    let c = client.get_connection(workbook_id, id).await?;

    if !yes && !json {
        print!(
            "Are you sure you want to delete connection \"{}\" ({})? [y/N] ",
            c.display_name, id
        );
        io::stdout().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        let response = line.trim().to_lowercase();
        if response != "y" && response != "yes" {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_connection(workbook_id, id).await?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "success": true,
                "id": id,
                "name": c.display_name,
            }))?
        );
    } else {
        println!("Connection \"{}\" deleted successfully.", c.display_name);
    }
    Ok(())
}
