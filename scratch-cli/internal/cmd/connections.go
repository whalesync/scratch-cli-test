package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	survey "github.com/AlecAivazis/survey/v2"
	"github.com/spf13/cobra"
	"github.com/whalesync/scratch-cli/internal/api"
)

// authField describes a credential field required by a service.
type authField struct {
	Key         string // Key sent in userProvidedParams (e.g. "apiKey", "shopDomain")
	DisplayName string // Human-readable label for prompts
	Description string // Help text shown in interactive mode
	Required    bool
	Sensitive   bool // If true, input is masked (password prompt)
}

// serviceAuthConfig maps each supported service to its required credential fields.
var serviceAuthConfig = map[string][]authField{
	"WEBFLOW": {
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Webflow API token", Required: true, Sensitive: true},
	},
	"AUDIENCEFUL": {
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Audienceful API key", Required: true, Sensitive: true},
	},
	"SHOPIFY": {
		{Key: "shopDomain", DisplayName: "Shop Domain", Description: "Your Shopify store (e.g. my-store or my-store.myshopify.com)", Required: true, Sensitive: false},
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Shopify Admin API access token", Required: true, Sensitive: true},
	},
	"MOCO": {
		{Key: "domain", DisplayName: "Moco Domain", Description: "Your Moco subdomain (e.g. yourcompany for yourcompany.mocoapp.com)", Required: true, Sensitive: false},
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Moco API key", Required: true, Sensitive: true},
	},
	"WORDPRESS": {
		{Key: "endpoint", DisplayName: "WordPress URL", Description: "The URL of your WordPress site (e.g. https://example.com)", Required: true, Sensitive: false},
		{Key: "username", DisplayName: "Username", Description: "Your WordPress account username", Required: true, Sensitive: false},
		{Key: "password", DisplayName: "Application Password", Description: "Your WordPress application password (generate in Users > Profile)", Required: true, Sensitive: true},
	},
	"AIRTABLE": {
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Airtable personal access token", Required: true, Sensitive: true},
	},
	"POSTGRES": {
		{Key: "connectionString", DisplayName: "Connection String", Description: "PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)", Required: true, Sensitive: true},
	},
	"SUPABASE": {
		{Key: "connectionString", DisplayName: "Connection String", Description: "Supabase connection string (find in Settings > Database > Connection string)", Required: true, Sensitive: true},
	},
	"PIPEDRIVE": {
		{Key: "apiKey", DisplayName: "API Key", Description: "Your Pipedrive API token (find in Settings > Personal preferences > API)", Required: true, Sensitive: true},
	},
}

// supportedServices returns the list of service names in display order.
func supportedServices() []string {
	return []string{"AIRTABLE", "WEBFLOW", "SHOPIFY", "MOCO", "AUDIENCEFUL", "WORDPRESS", "POSTGRES", "SUPABASE", "PIPEDRIVE"}
}

var connectionsCmd = &cobra.Command{
	Use:   "connections",
	Short: "Manage connections",
	Long: `Manage connections (connector accounts) in a workspace.

Commands:
  connections list      List all connections
  connections add       Authorize a new connection
  connections show      Show connection details
  connections remove    Delete a connection`,
}

var connectionsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all connections in the workspace",
	Long: `List all connections in a workspace.

If run inside a workspace directory (contains .scratchmd marker), the workspace
is detected automatically. Otherwise, use the --workspace flag.

Examples:
  scratchmd connections list
  scratchmd connections list --workspace wb_abc123`,
	RunE: runConnectionsList,
}

var connectionsAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Authorize a new connection",
	Long: `Create a new connection in the workspace.

In interactive mode (no flags), you will be prompted for the service and
its required credentials. In non-interactive mode, provide --service and
--param flags for each required credential field.

Non-interactive examples:
  scratchmd connections add --service AIRTABLE --param apiKey=<token>
  scratchmd connections add --service WEBFLOW --param apiKey=<key>
  scratchmd connections add --service SHOPIFY --param shopDomain=my-store --param apiKey=<key>
  scratchmd connections add --service WORDPRESS --param endpoint=https://example.com --param username=admin --param password=<app-password>
  scratchmd connections add --service MOCO --param domain=yourcompany --param apiKey=<key>
  scratchmd connections add --service PIPEDRIVE --param apiKey=<token>
  scratchmd connections add --service POSTGRES --param connectionString=postgresql://user:pass@host:5432/db
  scratchmd connections add --service SUPABASE --param connectionString=postgresql://postgres.[ref]:[password]@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,
	RunE: runConnectionsAdd,
}

var connectionsShowCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show connection details",
	Long: `Show details for a connection.

Examples:
  scratchmd connections show conn_abc123
  scratchmd connections show conn_abc123 --workspace wb_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: runConnectionsShow,
}

var connectionsRemoveCmd = &cobra.Command{
	Use:   "remove <id>",
	Short: "Delete a connection",
	Long: `Delete a connection from the workspace.

Examples:
  scratchmd connections remove conn_abc123
  scratchmd connections remove conn_abc123 --yes`,
	Args: cobra.ExactArgs(1),
	RunE: runConnectionsRemove,
}

func init() {
	rootCmd.AddCommand(connectionsCmd)
	connectionsCmd.PersistentFlags().String("workspace", "", "Workspace ID (auto-detected from .scratchmd if not set)")
	connectionsCmd.PersistentFlags().String("workbook", "", "Workspace ID (auto-detected from .scratchmd if not set)")
	connectionsCmd.PersistentFlags().MarkHidden("workbook")

	connectionsCmd.AddCommand(connectionsListCmd)
	connectionsCmd.AddCommand(connectionsAddCmd)
	connectionsCmd.AddCommand(connectionsShowCmd)
	connectionsCmd.AddCommand(connectionsRemoveCmd)

	// --json flag on each subcommand
	connectionsListCmd.Flags().Bool("json", false, "Output as JSON")
	connectionsAddCmd.Flags().Bool("json", false, "Output as JSON")
	connectionsShowCmd.Flags().Bool("json", false, "Output as JSON")
	connectionsRemoveCmd.Flags().Bool("json", false, "Output as JSON")

	// Command-specific flags
	connectionsRemoveCmd.Flags().Bool("yes", false, "Skip confirmation prompt")
	connectionsAddCmd.Flags().String("service", "", "Service type (AIRTABLE, WEBFLOW, SHOPIFY, MOCO, AUDIENCEFUL, WORDPRESS, POSTGRES, SUPABASE, PIPEDRIVE)")
	connectionsAddCmd.Flags().StringSlice("param", nil, "Credential parameter as key=value (repeatable)")
	connectionsAddCmd.Flags().String("name", "", "Display name for the connection")
}

func runConnectionsList(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	connections, err := client.ListConnections(workbookID)
	if err != nil {
		return fmt.Errorf("failed to list connections: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(connections)
	}

	if len(connections) == 0 {
		fmt.Println("No connections found in this workspace.")
		fmt.Println()
		fmt.Println("Add a connection with: scratchmd connections add")
		return nil
	}

	fmt.Println()
	fmt.Printf("  %-36s  %-14s  %-20s  %-8s  %s\n", "ID", "SERVICE", "NAME", "HEALTH", "CREATED")
	fmt.Printf("  %-36s  %-14s  %-20s  %-8s  %s\n", "----", "-------", "----", "------", "-------")
	for _, c := range connections {
		health := "-"
		if c.HealthStatus != nil {
			health = *c.HealthStatus
		}
		created := c.CreatedAt
		if len(created) > 10 {
			created = created[:10]
		}
		name := c.DisplayName
		if len(name) > 20 {
			name = name[:17] + "..."
		}
		fmt.Printf("  %-36s  %-14s  %-20s  %-8s  %s\n", c.ID, c.Service, name, health, created)
	}
	fmt.Println()

	return nil
}

// parseParams parses --param key=value flags into a map.
func parseParams(raw []string) (map[string]string, error) {
	params := make(map[string]string)
	for _, p := range raw {
		parts := strings.SplitN(p, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid --param format %q, expected key=value", p)
		}
		params[parts[0]] = parts[1]
	}
	return params, nil
}

func runConnectionsAdd(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	service, _ := cmd.Flags().GetString("service")
	rawParams, _ := cmd.Flags().GetStringSlice("param")
	name, _ := cmd.Flags().GetString("name")

	if service != "" && len(rawParams) > 0 {
		// Non-interactive mode
		service = strings.ToUpper(service)
		params, err := parseParams(rawParams)
		if err != nil {
			return err
		}

		// Validate required fields if we know this service
		if fields, ok := serviceAuthConfig[service]; ok {
			var missing []string
			for _, f := range fields {
				if f.Required {
					if _, exists := params[f.Key]; !exists {
						missing = append(missing, fmt.Sprintf("%s (%s)", f.Key, f.DisplayName))
					}
				}
			}
			if len(missing) > 0 {
				return fmt.Errorf("missing required params for %s: %s", service, strings.Join(missing, ", "))
			}
		}

		req := &api.CreateConnectionRequest{
			Service:            service,
			DisplayName:        name,
			UserProvidedParams: params,
		}

		result, err := client.CreateConnection(workbookID, req)
		if err != nil {
			return fmt.Errorf("failed to create connection: %w", err)
		}

		return printConnectionCreated(result, jsonOutput)
	}

	// Interactive mode
	var selectedService string
	servicePrompt := &survey.Select{
		Message: "Select a service:",
		Options: supportedServices(),
	}
	if err := survey.AskOne(servicePrompt, &selectedService); err != nil {
		return fmt.Errorf("prompt cancelled: %w", err)
	}

	fields, ok := serviceAuthConfig[selectedService]
	if !ok {
		return fmt.Errorf("unknown service %q", selectedService)
	}

	// Collect credential fields
	params := make(map[string]string)
	for _, field := range fields {
		var value string
		if field.Sensitive {
			prompt := &survey.Password{
				Message: fmt.Sprintf("%s:", field.DisplayName),
				Help:    field.Description,
			}
			if err := survey.AskOne(prompt, &value); err != nil {
				return fmt.Errorf("prompt cancelled: %w", err)
			}
		} else {
			prompt := &survey.Input{
				Message: fmt.Sprintf("%s:", field.DisplayName),
				Help:    field.Description,
			}
			if err := survey.AskOne(prompt, &value); err != nil {
				return fmt.Errorf("prompt cancelled: %w", err)
			}
		}

		value = strings.TrimSpace(value)
		if field.Required && value == "" {
			return fmt.Errorf("%s cannot be empty", field.DisplayName)
		}
		if value != "" {
			params[field.Key] = value
		}
	}

	// Prompt for display name
	lower := strings.ToLower(selectedService)
	defaultName := strings.ToUpper(lower[:1]) + lower[1:]
	var displayName string
	namePrompt := &survey.Input{
		Message: "Display name:",
		Default: defaultName,
	}
	if err := survey.AskOne(namePrompt, &displayName); err != nil {
		return fmt.Errorf("prompt cancelled: %w", err)
	}
	if displayName == "" {
		displayName = defaultName
	}

	req := &api.CreateConnectionRequest{
		Service:            selectedService,
		DisplayName:        displayName,
		UserProvidedParams: params,
	}

	result, err := client.CreateConnection(workbookID, req)
	if err != nil {
		return fmt.Errorf("failed to create connection: %w", err)
	}

	return printConnectionCreated(result, jsonOutput)
}

func printConnectionCreated(result *api.Connection, jsonOutput bool) error {
	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	fmt.Printf("\nConnection '%s' created successfully.\n", result.DisplayName)
	fmt.Printf("  ID:      %s\n", result.ID)
	fmt.Printf("  Service: %s\n", result.Service)
	if result.HealthStatus != nil {
		fmt.Printf("  Health:  %s\n", *result.HealthStatus)
	}
	if result.HealthStatusMessage != nil && *result.HealthStatusMessage != "" {
		fmt.Printf("  Message: %s\n", *result.HealthStatusMessage)
	}
	fmt.Println()
	return nil
}

func runConnectionsShow(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	connectionID := args[0]

	connection, err := client.GetConnection(workbookID, connectionID)
	if err != nil {
		return fmt.Errorf("failed to get connection: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(connection)
	}

	fmt.Println()
	fmt.Printf("  Name:    %s\n", connection.DisplayName)
	fmt.Printf("  ID:      %s\n", connection.ID)
	fmt.Printf("  Service: %s\n", connection.Service)
	fmt.Printf("  Auth:    %s\n", connection.AuthType)
	health := "-"
	if connection.HealthStatus != nil {
		health = *connection.HealthStatus
	}
	fmt.Printf("  Health:  %s\n", health)
	if connection.HealthStatusMessage != nil && *connection.HealthStatusMessage != "" {
		fmt.Printf("  Message: %s\n", *connection.HealthStatusMessage)
	}
	fmt.Printf("  Created: %s\n", connection.CreatedAt)
	fmt.Printf("  Updated: %s\n", connection.UpdatedAt)
	fmt.Println()

	return nil
}

func runConnectionsRemove(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")
	yes, _ := cmd.Flags().GetBool("yes")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	connectionID := args[0]

	// Get details for confirmation
	connection, err := client.GetConnection(workbookID, connectionID)
	if err != nil {
		return fmt.Errorf("failed to get connection: %w", err)
	}

	// Confirmation prompt
	if !yes && !jsonOutput {
		fmt.Printf("Are you sure you want to delete connection \"%s\" (%s)? [y/N] ", connection.DisplayName, connection.ID)
		reader := bufio.NewReader(os.Stdin)
		response, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("failed to read response: %w", err)
		}
		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	if err := client.DeleteConnection(workbookID, connectionID); err != nil {
		return fmt.Errorf("failed to delete connection: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]interface{}{
			"success": true,
			"id":      connectionID,
			"name":    connection.DisplayName,
		})
	}

	fmt.Printf("Connection \"%s\" deleted successfully.\n", connection.DisplayName)

	return nil
}
