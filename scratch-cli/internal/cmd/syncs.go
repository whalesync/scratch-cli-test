package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

// syncsCmd represents the syncs command group
var syncsCmd = &cobra.Command{
	Use:   "syncs",
	Short: "Manage sync configurations",
	Long: `Manage sync configurations for a workbook.

Commands:
  syncs list        List sync configurations
  syncs show        Show sync details
  syncs create      Create a new sync
  syncs update      Update a sync
  syncs delete      Delete a sync
  syncs run         Execute a sync`,
}

var syncsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List sync configurations",
	Long: `List all sync configurations for a workbook.

If run inside a workbook directory (contains .scratchmd marker), the workbook
is detected automatically. Otherwise, use the --workbook flag.

Examples:
  scratchmd syncs list
  scratchmd syncs list --workbook wb_abc123
  scratchmd syncs list --json`,
	RunE: runSyncsList,
}

var syncsShowCmd = &cobra.Command{
	Use:   "show <sync-id>",
	Short: "Show sync details",
	Long: `Show details for a specific sync configuration.

Examples:
  scratchmd syncs show sync_abc123
  scratchmd syncs show sync_abc123 --json`,
	Args: cobra.ExactArgs(1),
	RunE: runSyncsShow,
}

var syncsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sync",
	Long: `Create a new sync configuration from a JSON config.

The --config flag accepts either a file path or inline JSON.

Examples:
  scratchmd syncs create --config sync-config.json
  scratchmd syncs create --config '{"displayName":"My Sync","mappings":{"version":1,"tableMappings":[...]}}'
  scratchmd syncs create --workbook wb_abc123 --config sync-config.json`,
	RunE: runSyncsCreate,
}

var syncsUpdateCmd = &cobra.Command{
	Use:   "update <sync-id>",
	Short: "Update a sync",
	Long: `Update an existing sync configuration from a JSON config.

The --config flag accepts either a file path or inline JSON.

Examples:
  scratchmd syncs update sync_abc123 --config sync-config.json
  scratchmd syncs update sync_abc123 --config '{"displayName":"Updated","mappings":{"version":1,"tableMappings":[...]}}'`,
	Args: cobra.ExactArgs(1),
	RunE: runSyncsUpdate,
}

var syncsDeleteCmd = &cobra.Command{
	Use:   "delete <sync-id>",
	Short: "Delete a sync",
	Long: `Delete a sync configuration.

Examples:
  scratchmd syncs delete sync_abc123
  scratchmd syncs delete sync_abc123 --yes`,
	Args: cobra.ExactArgs(1),
	RunE: runSyncsDelete,
}

var syncsRunCmd = &cobra.Command{
	Use:   "run <sync-id>",
	Short: "Execute a sync",
	Long: `Execute a sync and wait for completion.

Examples:
  scratchmd syncs run sync_abc123
  scratchmd syncs run sync_abc123 --no-wait
  scratchmd syncs run sync_abc123 --json`,
	Args: cobra.ExactArgs(1),
	RunE: runSyncsRun,
}

func init() {
	rootCmd.AddCommand(syncsCmd)
	syncsCmd.PersistentFlags().String("workbook", "", "Workbook ID (auto-detected from .scratchmd if not set)")

	syncsCmd.AddCommand(syncsListCmd)
	syncsCmd.AddCommand(syncsShowCmd)
	syncsCmd.AddCommand(syncsCreateCmd)
	syncsCmd.AddCommand(syncsUpdateCmd)
	syncsCmd.AddCommand(syncsDeleteCmd)
	syncsCmd.AddCommand(syncsRunCmd)

	// --json flag on subcommands
	syncsListCmd.Flags().Bool("json", false, "Output as JSON")
	syncsShowCmd.Flags().Bool("json", false, "Output as JSON")
	syncsCreateCmd.Flags().Bool("json", false, "Output as JSON")
	syncsUpdateCmd.Flags().Bool("json", false, "Output as JSON")
	syncsDeleteCmd.Flags().Bool("json", false, "Output as JSON")
	syncsRunCmd.Flags().Bool("json", false, "Output as JSON")

	// Command-specific flags
	syncsCreateCmd.Flags().String("config", "", "JSON config (file path or inline JSON)")
	syncsCreateCmd.MarkFlagRequired("config")
	syncsUpdateCmd.Flags().String("config", "", "JSON config (file path or inline JSON)")
	syncsUpdateCmd.MarkFlagRequired("config")
	syncsDeleteCmd.Flags().Bool("yes", false, "Skip confirmation prompt")
	syncsRunCmd.Flags().Bool("no-wait", false, "Don't wait for the sync job to complete")
}

// loadConfigFlag reads the --config flag value as either a file path or inline JSON.
func loadConfigFlag(cmd *cobra.Command) (json.RawMessage, error) {
	configValue, _ := cmd.Flags().GetString("config")
	if configValue == "" {
		return nil, fmt.Errorf("--config is required")
	}

	// Check if the value is a file path
	if _, err := os.Stat(configValue); err == nil {
		data, err := os.ReadFile(configValue)
		if err != nil {
			return nil, fmt.Errorf("failed to read config file: %w", err)
		}
		// Validate it's valid JSON
		if !json.Valid(data) {
			return nil, fmt.Errorf("config file does not contain valid JSON")
		}
		return json.RawMessage(data), nil
	}

	// Treat as inline JSON
	data := []byte(configValue)
	if !json.Valid(data) {
		return nil, fmt.Errorf("config value is not valid JSON and is not a readable file path")
	}
	return json.RawMessage(data), nil
}

func runSyncsList(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	syncs, err := client.ListSyncs(workbookID)
	if err != nil {
		return fmt.Errorf("failed to list syncs: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(syncs)
	}

	if len(syncs) == 0 {
		fmt.Println("No syncs found in this workbook.")
		fmt.Println()
		fmt.Println("Create one with: scratchmd syncs create --config sync-config.json")
		return nil
	}

	fmt.Println()
	fmt.Printf("Found %d sync(s):\n", len(syncs))
	fmt.Println()

	for _, s := range syncs {
		name := s.DisplayName
		if name == "" {
			name = "(unnamed)"
		}
		fmt.Printf("  Name:    %s\n", name)
		fmt.Printf("  ID:      %s\n", s.ID)
		if s.SyncState != "" {
			fmt.Printf("  State:   %s\n", s.SyncState)
		}
		if s.LastSyncTime != nil {
			fmt.Printf("  Last:    %s\n", *s.LastSyncTime)
		}
		fmt.Printf("  Pairs:   %d\n", len(s.SyncTablePairs))
		fmt.Println()
	}

	return nil
}

func runSyncsShow(cmd *cobra.Command, args []string) error {
	syncID := args[0]
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	if jsonOutput {
		sync, err := client.GetSync(workbookID, syncID)
		if err != nil {
			return fmt.Errorf("failed to get sync: %w", err)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(sync)
	}

	raw, err := client.GetSyncRaw(workbookID, syncID)
	if err != nil {
		return fmt.Errorf("failed to get sync: %w", err)
	}

	var data interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		return fmt.Errorf("failed to parse sync data: %w", err)
	}

	fmt.Println()
	prettyPrint(data, 1)
	return nil
}

// prettyPrint recursively prints any JSON value with indentation.
func prettyPrint(v interface{}, indent int) {
	prefix := strings.Repeat("  ", indent)

	switch val := v.(type) {
	case map[string]interface{}:
		for _, key := range sortedKeys(val) {
			child := val[key]
			label := camelToTitle(key)
			switch typedChild := child.(type) {
			case map[string]interface{}:
				fmt.Printf("%s%s:\n", prefix, label)
				prettyPrint(typedChild, indent+1)
			case []interface{}:
				fmt.Printf("%s%s:\n", prefix, label)
				prettyPrintArray(typedChild, indent+1)
			case nil:
				fmt.Printf("%s%s: -\n", prefix, label)
			default:
				fmt.Printf("%s%s: %v\n", prefix, label, child)
			}
		}
	default:
		fmt.Printf("%s%v\n", prefix, v)
	}
}

// prettyPrintArray prints a JSON array with indentation.
func prettyPrintArray(arr []interface{}, indent int) {
	prefix := strings.Repeat("  ", indent)
	for i, item := range arr {
		switch typedItem := item.(type) {
		case map[string]interface{}:
			if i > 0 {
				fmt.Println()
			}
			fmt.Printf("%s[%d]\n", prefix, i+1)
			prettyPrint(typedItem, indent+1)
		default:
			fmt.Printf("%s- %v\n", prefix, item)
		}
	}
}

// sortedKeys returns map keys in a stable order.
func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sort alphabetically but push "id" and "name"/"displayName" to the top
	sort.Slice(keys, func(i, j int) bool {
		ri := keyRank(keys[i])
		rj := keyRank(keys[j])
		if ri != rj {
			return ri < rj
		}
		return keys[i] < keys[j]
	})
	return keys
}

func keyRank(key string) int {
	switch strings.ToLower(key) {
	case "id":
		return 0
	case "name", "displayname":
		return 1
	default:
		return 2
	}
}

// camelToTitle converts a camelCase key to a Title Case label.
func camelToTitle(s string) string {
	if s == "" {
		return s
	}
	var result []rune
	for i, r := range s {
		if i == 0 {
			result = append(result, []rune(strings.ToUpper(string(r)))...)
			continue
		}
		if r >= 'A' && r <= 'Z' {
			result = append(result, ' ')
		}
		result = append(result, r)
	}
	return string(result)
}

func runSyncsCreate(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	configData, err := loadConfigFlag(cmd)
	if err != nil {
		return err
	}

	sync, err := client.CreateSync(workbookID, configData)
	if err != nil {
		return fmt.Errorf("failed to create sync: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(sync)
	}

	name := sync.DisplayName
	if name == "" {
		name = "(unnamed)"
	}

	fmt.Println()
	fmt.Printf("Sync \"%s\" created successfully.\n", name)
	fmt.Printf("  ID: %s\n", sync.ID)
	fmt.Println()

	return nil
}

func runSyncsUpdate(cmd *cobra.Command, args []string) error {
	syncID := args[0]
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	configData, err := loadConfigFlag(cmd)
	if err != nil {
		return err
	}

	sync, err := client.UpdateSync(workbookID, syncID, configData)
	if err != nil {
		return fmt.Errorf("failed to update sync: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(sync)
	}

	name := sync.DisplayName
	if name == "" {
		name = "(unnamed)"
	}

	fmt.Println()
	fmt.Printf("Sync \"%s\" updated successfully.\n", name)
	fmt.Println()

	return nil
}

func runSyncsDelete(cmd *cobra.Command, args []string) error {
	syncID := args[0]
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

	// Get sync details for confirmation
	sync, err := client.GetSync(workbookID, syncID)
	if err != nil {
		return fmt.Errorf("failed to get sync: %w", err)
	}

	name := sync.DisplayName
	if name == "" {
		name = "(unnamed)"
	}

	// Confirmation prompt
	if !yes && !jsonOutput {
		fmt.Printf("Are you sure you want to delete sync \"%s\" (%s)? [y/N] ", name, syncID)
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

	if err := client.DeleteSync(workbookID, syncID); err != nil {
		return fmt.Errorf("failed to delete sync: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]interface{}{
			"success": true,
			"id":      syncID,
			"name":    name,
		})
	}

	fmt.Printf("Sync \"%s\" deleted successfully.\n", name)
	return nil
}

func runSyncsRun(cmd *cobra.Command, args []string) error {
	syncID := args[0]
	jsonOutput, _ := cmd.Flags().GetBool("json")
	noWait, _ := cmd.Flags().GetBool("no-wait")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbookID, err := resolveWorkbookContext(cmd)
	if err != nil {
		return err
	}

	resp, err := client.RunSync(workbookID, syncID)
	if err != nil {
		return fmt.Errorf("failed to run sync: %w", err)
	}

	if jsonOutput && noWait {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(resp)
	}

	if noWait {
		fmt.Printf("Sync job queued (job ID: %s).\n", resp.JobID)
		return nil
	}

	fmt.Fprintf(os.Stderr, "Sync job started (job ID: %s). Waiting for completion", resp.JobID)

	if err := pollJobUntilDone(client, resp.JobID); err != nil {
		return err
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]interface{}{
			"success": true,
			"jobId":   resp.JobID,
			"message": "Sync completed successfully",
		})
	}

	fmt.Println("Sync completed successfully.")
	return nil
}
