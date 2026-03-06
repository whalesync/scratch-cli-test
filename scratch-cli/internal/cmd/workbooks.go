package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing/transport"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
	"github.com/spf13/cobra"
	"github.com/whalesync/scratch-cli/internal/api"
	"github.com/whalesync/scratch-cli/internal/config"
	"gopkg.in/yaml.v3"
)

// APITokenAuth implements transport.AuthMethod for API token authentication
type APITokenAuth struct {
	Token string
}

// Name returns the name of the auth method
func (a *APITokenAuth) Name() string {
	return "api-token"
}

// String returns a string representation
func (a *APITokenAuth) String() string {
	return "API-Token authentication"
}

// SetAuth sets the auth header on the request
func (a *APITokenAuth) SetAuth(r *http.Request) {
	r.Header.Set("Authorization", "API-Token "+a.Token)
}

// Ensure APITokenAuth implements the required interface
var _ githttp.AuthMethod = &APITokenAuth{}
var _ transport.AuthMethod = &APITokenAuth{}

// workbooksCmd represents the workbooks command
var workbooksCmd = &cobra.Command{
	Use:     "workspaces",
	Aliases: []string{"workbooks"},
	Short:   "Manage workspaces",
	Long: `Manage your workspaces in Scratch.md.

Commands:
  workspaces list      List all workspaces
  workspaces create    Create a new workspace
  workspaces show      Show workspace details
  workspaces delete    Delete a workspace
  workspaces init      Initialize a local copy of a workspace`,
}

// workbooksListCmd represents the workbooks list command
var workbooksListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all workspaces",
	Long:  `List all workspaces for your account.`,
	RunE:  runWorkbooksList,
}

// workbooksCreateCmd represents the workbooks create command
var workbooksCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new workspace",
	Long:  `Create a new workspace in your account.`,
	RunE:  runWorkbooksCreate,
}

// workbooksShowCmd represents the workbooks show command
var workbooksShowCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show workspace details",
	Long:  `Show details for a specific workspace.`,
	Args:  cobra.ExactArgs(1),
	RunE:  runWorkbooksShow,
}

// workbooksDeleteCmd represents the workbooks delete command
var workbooksDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a workspace",
	Long:  `Delete a workspace from your account.`,
	Args:  cobra.ExactArgs(1),
	RunE:  runWorkbooksDelete,
}

// workbooksInitCmd represents the workbooks init command
var workbooksInitCmd = &cobra.Command{
	Use:   "init <workspace-id>",
	Short: "Initialize a local copy of a workspace",
	Long: `Initialize a local directory with a workspace's files.

Downloads all files from the workspace and creates a .scratchmd marker file
to track the workspace association.

Example:
  scratchmd workspaces init abc123
  scratchmd workspaces init abc123 --output ./my-project
  scratchmd workspaces init abc123 --force  # Overwrite existing directory`,
	Args: cobra.ExactArgs(1),
	RunE: runWorkbooksInit,
}

func init() {
	rootCmd.AddCommand(workbooksCmd)
	workbooksCmd.AddCommand(workbooksListCmd)
	workbooksCmd.AddCommand(workbooksCreateCmd)
	workbooksCmd.AddCommand(workbooksShowCmd)
	workbooksCmd.AddCommand(workbooksDeleteCmd)
	workbooksCmd.AddCommand(workbooksInitCmd)

	// Flags for workbooks list
	workbooksListCmd.Flags().String("sort-by", "createdAt", "Sort by field (name, createdAt, updatedAt)")
	workbooksListCmd.Flags().String("sort-order", "desc", "Sort order (asc, desc)")
	workbooksListCmd.Flags().Bool("json", false, "Output as JSON")

	// Flags for workbooks create
	workbooksCreateCmd.Flags().String("name", "", "Workspace name")
	workbooksCreateCmd.Flags().Bool("json", false, "Output as JSON")

	// Flags for workbooks show
	workbooksShowCmd.Flags().Bool("json", false, "Output as JSON")

	// Flags for workbooks delete
	workbooksDeleteCmd.Flags().Bool("yes", false, "Skip confirmation prompt")

	// Flags for workbooks init
	workbooksInitCmd.Flags().StringP("output", "o", ".", "Output directory")
	workbooksInitCmd.Flags().Bool("force", false, "Overwrite existing directory")
	workbooksInitCmd.Flags().Bool("json", false, "Output as JSON")
}

func getAuthenticatedClient() (*api.Client, error) {
	serverURL := getServerURL()

	if !config.IsLoggedIn(serverURL) {
		return nil, fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return nil, fmt.Errorf("failed to load credentials: %w", err)
	}

	client := api.NewClient(
		api.WithBaseURL(serverURL),
		api.WithAPIToken(creds.APIToken),
	)

	return client, nil
}

func getServerURL() string {
	cfg, err := config.LoadConfig()
	if err == nil && cfg.Settings != nil && cfg.Settings.ScratchServerURL != "" {
		return cfg.Settings.ScratchServerURL
	}
	return api.DefaultScratchServerURL
}

func runWorkbooksList(cmd *cobra.Command, args []string) error {
	sortBy, _ := cmd.Flags().GetString("sort-by")
	sortOrder, _ := cmd.Flags().GetString("sort-order")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	result, err := client.ListWorkbooks(sortBy, sortOrder)
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	// Human-readable output
	if len(result.Workbooks) == 0 {
		fmt.Println("No workspaces found.")
		fmt.Println()
		fmt.Println("Create one with: scratchmd workspaces create --name \"My Workspace\"")
		return nil
	}

	fmt.Println()
	fmt.Printf("Found %d workspace(s):\n", len(result.Workbooks))
	fmt.Println()

	for _, wb := range result.Workbooks {
		name := wb.Name
		if name == "" {
			name = "(unnamed)"
		}
		fmt.Printf("  Name:    %s\n", name)
		fmt.Printf("  ID:      %s\n", wb.ID)
		fmt.Printf("  Created: %s\n", wb.CreatedAt)
		fmt.Println()
	}

	return nil
}

func runWorkbooksCreate(cmd *cobra.Command, args []string) error {
	name, _ := cmd.Flags().GetString("name")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbook, err := client.CreateWorkbook(name)
	if err != nil {
		return fmt.Errorf("failed to create workspace: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(workbook)
	}

	// Human-readable output
	fmt.Println()
	fmt.Println("Workspace created successfully!")
	fmt.Println()
	displayName := workbook.Name
	if displayName == "" {
		displayName = "(unnamed)"
	}
	fmt.Printf("  ID:      %s\n", workbook.ID)
	fmt.Printf("  Name:    %s\n", displayName)
	fmt.Printf("  Created: %s\n", workbook.CreatedAt)
	fmt.Println()

	return nil
}

func runWorkbooksShow(cmd *cobra.Command, args []string) error {
	id := args[0]
	jsonOutput, _ := cmd.Flags().GetBool("json")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	workbook, err := client.GetWorkbook(id)
	if err != nil {
		return fmt.Errorf("failed to get workspace: %w", err)
	}

	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(workbook)
	}

	// Human-readable output
	fmt.Println()
	displayName := workbook.Name
	if displayName == "" {
		displayName = "(unnamed)"
	}
	fmt.Printf("  ID:      %s\n", workbook.ID)
	fmt.Printf("  Name:    %s\n", displayName)
	fmt.Printf("  Tables:  %d\n", workbook.TableCount)
	fmt.Printf("  Created: %s\n", workbook.CreatedAt)
	fmt.Printf("  Updated: %s\n", workbook.UpdatedAt)
	fmt.Println()

	return nil
}

func runWorkbooksDelete(cmd *cobra.Command, args []string) error {
	id := args[0]
	yes, _ := cmd.Flags().GetBool("yes")

	client, err := getAuthenticatedClient()
	if err != nil {
		return err
	}

	// First get the workbook to show name in confirmation
	workbook, err := client.GetWorkbook(id)
	if err != nil {
		return fmt.Errorf("failed to get workspace: %w", err)
	}

	displayName := workbook.Name
	if displayName == "" {
		displayName = "(unnamed)"
	}

	// Confirmation prompt
	if !yes {
		fmt.Printf("Are you sure you want to delete workspace \"%s\" (%s)? [y/N] ", displayName, id)
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

	if err := client.DeleteWorkbook(id); err != nil {
		return fmt.Errorf("failed to delete workspace: %w", err)
	}

	fmt.Printf("Workspace \"%s\" deleted successfully.\n", displayName)
	return nil
}

// WorkbookMarker represents the .scratchmd marker file structure
type WorkbookMarker struct {
	Version  string         `yaml:"version"`
	Workbook WorkbookConfig `yaml:"workbook"`
}

// WorkbookConfig represents the workbook configuration in the marker file
type WorkbookConfig struct {
	ID            string `yaml:"id"`
	Name          string `yaml:"name"`
	ServerURL     string `yaml:"serverUrl"`
	InitializedAt string `yaml:"initializedAt"`
}

// DataFolderMarker represents the .scratchmd marker file structure for data folders
type DataFolderMarker struct {
	Version    string           `yaml:"version"`
	DataFolder DataFolderConfig `yaml:"dataFolder"`
}

// DataFolderConfig represents the data folder configuration in the marker file
type DataFolderConfig struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
}

// ConnectorMarker represents the .scratchmd marker file in a V2 connector subdirectory
type ConnectorMarker struct {
	Version   string          `yaml:"version"`
	Workbook  WorkbookRef     `yaml:"workbook"`
	Connector ConnectorConfig `yaml:"connector"`
}

// WorkbookRef is a minimal workbook reference stored in connector markers
type WorkbookRef struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
}

// ConnectorConfig represents the connector configuration in the marker file
type ConnectorConfig struct {
	ID          string `yaml:"id"`
	DisplayName string `yaml:"displayName"`
	Service     string `yaml:"service"`
	RepoPath    string `yaml:"repoPath,omitempty"`
}

// InitResult represents the result of a workbooks init operation (for JSON output)
type InitResult struct {
	WorkbookID   string `json:"workbookId"`
	WorkbookName string `json:"workbookName"`
	Directory    string `json:"directory"`
	FileCount    int    `json:"fileCount"`
}

func runWorkbooksInit(cmd *cobra.Command, args []string) error {
	workbookID := args[0]
	outputDir, _ := cmd.Flags().GetString("output")
	force, _ := cmd.Flags().GetBool("force")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	serverURL := getServerURL()

	if !config.IsLoggedIn(serverURL) {
		return fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return fmt.Errorf("failed to load credentials: %w", err)
	}

	client := api.NewClient(
		api.WithBaseURL(serverURL),
		api.WithAPIToken(creds.APIToken),
	)

	// 1. Check if workbook is already initialized in the output directory
	existingDir, err := findExistingWorkbookMarker(outputDir, workbookID)
	if err != nil {
		return fmt.Errorf("failed to check for existing workspace: %w", err)
	}

	if existingDir != "" {
		if force {
			// Remove existing directory to do a fresh clone
			if err := os.RemoveAll(existingDir); err != nil {
				return fmt.Errorf("failed to remove existing directory: %w", err)
			}
		} else if jsonOutput {
			return fmt.Errorf("workspace %s is already initialized at %s (use --force to overwrite)", workbookID, existingDir)
		} else {
			fmt.Printf("\nWorkspace is already initialized at %q.\n", existingDir)
			fmt.Print("Overwrite with fresh files? [y/N]: ")

			reader := bufio.NewReader(os.Stdin)
			response, _ := reader.ReadString('\n')
			response = strings.TrimSpace(strings.ToLower(response))

			if response != "y" && response != "yes" {
				fmt.Println("Cancelled.")
				return nil
			}

			// Remove existing directory to do a fresh clone
			if err := os.RemoveAll(existingDir); err != nil {
				return fmt.Errorf("failed to remove existing directory: %w", err)
			}
		}
	}

	// 2. Get workbook metadata (includes git URL)
	workbook, err := client.GetWorkbook(workbookID)
	if err != nil {
		return fmt.Errorf("failed to get workspace: %w", err)
	}

	// 3. Determine target directory
	workbookName := workbook.Name
	if workbookName == "" {
		workbookName = workbookID
	}
	targetDir := filepath.Join(outputDir, workbookName)

	// Branch on V2 vs V1
	if workbook.Version >= 2 {
		return initV2Workbook(workbook, targetDir, serverURL, creds, jsonOutput)
	}
	return initV1Workbook(workbook, targetDir, serverURL, creds, jsonOutput)
}

func initV1Workbook(workbook *api.Workbook, targetDir, serverURL string, creds *config.GlobalCredentials, jsonOutput bool) error {
	if workbook.GitUrl == "" {
		return fmt.Errorf("server did not return git URL for workspace")
	}

	gitAuth := &APITokenAuth{Token: creds.APIToken}

	repo, err := git.PlainClone(targetDir, false, &git.CloneOptions{
		URL:           workbook.GitUrl,
		Auth:          gitAuth,
		ReferenceName: "refs/heads/dirty",
		SingleBranch:  true,
		Depth:         0,
	})
	if err != nil {
		return fmt.Errorf("failed to clone workspace: %w", err)
	}

	_, err = repo.CreateRemote(&gitconfig.RemoteConfig{
		Name: "origin",
		URLs: []string{workbook.GitUrl},
	})
	if err != nil && err != git.ErrRemoteExists {
		return fmt.Errorf("failed to configure remote: %w", err)
	}

	marker := WorkbookMarker{
		Version: "1",
		Workbook: WorkbookConfig{
			ID:            workbook.ID,
			Name:          workbook.Name,
			ServerURL:     serverURL,
			InitializedAt: time.Now().UTC().Format(time.RFC3339),
		},
	}

	markerPath := filepath.Join(targetDir, ".scratchmd")
	markerData, err := yaml.Marshal(&marker)
	if err != nil {
		return fmt.Errorf("failed to marshal marker file: %w", err)
	}
	if err := os.WriteFile(markerPath, markerData, 0644); err != nil {
		return fmt.Errorf("failed to write marker file: %w", err)
	}

	if err := createDataFolderMarkers(targetDir, workbook.DataFolders); err != nil {
		return fmt.Errorf("failed to create data folder markers: %w", err)
	}

	fileCount := countFiles(targetDir)

	if jsonOutput {
		result := InitResult{
			WorkbookID:   workbook.ID,
			WorkbookName: workbook.Name,
			Directory:    targetDir,
			FileCount:    fileCount,
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	fmt.Println()
	if fileCount >= 0 {
		fmt.Printf("Initialized workspace '%s' (%d files)\n", workbook.Name, fileCount)
	} else {
		fmt.Printf("Initialized workspace '%s'\n", workbook.Name)
	}
	fmt.Printf("  Directory: %s\n", targetDir)
	fmt.Println()
	return nil
}

func initV2Workbook(workbook *api.Workbook, targetDir, serverURL string, creds *config.GlobalCredentials, jsonOutput bool) error {
	// Create workbook root directory
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return fmt.Errorf("failed to create workspace directory: %w", err)
	}

	// Write V2 workbook marker (no .git at root)
	marker := WorkbookMarker{
		Version: "2",
		Workbook: WorkbookConfig{
			ID:            workbook.ID,
			Name:          workbook.Name,
			ServerURL:     serverURL,
			InitializedAt: time.Now().UTC().Format(time.RFC3339),
		},
	}
	markerData, err := yaml.Marshal(&marker)
	if err != nil {
		return fmt.Errorf("failed to marshal marker file: %w", err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, ".scratchmd"), markerData, 0644); err != nil {
		return fmt.Errorf("failed to write marker file: %w", err)
	}

	if len(workbook.ConnectorAccounts) == 0 {
		if jsonOutput {
			result := InitResult{
				WorkbookID:   workbook.ID,
				WorkbookName: workbook.Name,
				Directory:    targetDir,
				FileCount:    0,
			}
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(result)
		}
		fmt.Println()
		fmt.Printf("Initialized workspace '%s' (no connections yet)\n", workbook.Name)
		fmt.Printf("  Directory: %s\n", targetDir)
		fmt.Println()
		fmt.Println("Add a connection in the web app, then run 'scratchmd workspaces init' again.")
		return nil
	}

	gitAuth := &APITokenAuth{Token: creds.APIToken}
	totalFiles := 0

	for _, ca := range workbook.ConnectorAccounts {
		// Sanitize directory name: "Service - DisplayName"
		connDirName := sanitizeFilename(ca.Service + " - " + ca.DisplayName)
		connDir := filepath.Join(targetDir, connDirName)

		if ca.GitUrl == "" {
			fmt.Printf("  Skipping connector %s (no git URL)\n", ca.DisplayName)
			continue
		}

		// Clone the connector's repo
		repo, err := git.PlainClone(connDir, false, &git.CloneOptions{
			URL:           ca.GitUrl,
			Auth:          gitAuth,
			ReferenceName: "refs/heads/dirty",
			SingleBranch:  true,
			Depth:         0,
		})
		if err != nil {
			return fmt.Errorf("failed to clone connector %s: %w", ca.DisplayName, err)
		}

		_, err = repo.CreateRemote(&gitconfig.RemoteConfig{
			Name: "origin",
			URLs: []string{ca.GitUrl},
		})
		if err != nil && err != git.ErrRemoteExists {
			// Ignore if remote already exists
		}

		// Write connector marker
		connMarker := ConnectorMarker{
			Version: "2",
			Workbook: WorkbookRef{
				ID:   workbook.ID,
				Name: workbook.Name,
			},
			Connector: ConnectorConfig{
				ID:          ca.ID,
				DisplayName: ca.DisplayName,
				Service:     ca.Service,
				RepoPath:    ca.RepoPath,
			},
		}
		connMarkerData, err := yaml.Marshal(&connMarker)
		if err != nil {
			return fmt.Errorf("failed to marshal connector marker: %w", err)
		}
		if err := os.WriteFile(filepath.Join(connDir, ".scratchmd"), connMarkerData, 0644); err != nil {
			return fmt.Errorf("failed to write connector marker: %w", err)
		}

		// Create data folder markers inside the connector directory
		if err := createDataFolderMarkers(connDir, ca.DataFolders); err != nil {
			return fmt.Errorf("failed to create data folder markers for %s: %w", ca.DisplayName, err)
		}

		fc := countFiles(connDir)
		if fc > 0 {
			totalFiles += fc
		}
	}

	if jsonOutput {
		result := InitResult{
			WorkbookID:   workbook.ID,
			WorkbookName: workbook.Name,
			Directory:    targetDir,
			FileCount:    totalFiles,
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	fmt.Println()
	fmt.Printf("Initialized workspace '%s' (%d files, %d connectors)\n", workbook.Name, totalFiles, len(workbook.ConnectorAccounts))
	fmt.Printf("  Directory: %s\n", targetDir)
	for _, ca := range workbook.ConnectorAccounts {
		connDirName := sanitizeFilename(ca.Service + " - " + ca.DisplayName)
		fmt.Printf("    %s/\n", connDirName)
	}
	fmt.Println()
	return nil
}

// countFiles counts files in a directory, excluding .git dirs and dotfiles. Returns -1 on error.
func countFiles(dir string) int {
	count := 0
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && info.Name() == ".git" {
			return filepath.SkipDir
		}
		if !info.IsDir() && !strings.HasPrefix(info.Name(), ".") {
			count++
		}
		return nil
	})
	if err != nil {
		return -1
	}
	return count
}

// sanitizeFilename replaces characters that are invalid in filenames.
func sanitizeFilename(name string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	return replacer.Replace(name)
}

// findExistingWorkbookMarker scans the output directory for a .scratchmd marker
// with the given workbook ID. Returns the directory path if found, empty string otherwise.
func findExistingWorkbookMarker(outputDir string, workbookID string) (string, error) {
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil // Output directory doesn't exist yet, no conflicts
		}
		return "", err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		markerPath := filepath.Join(outputDir, entry.Name(), ".scratchmd")
		data, err := os.ReadFile(markerPath)
		if err != nil {
			continue // No marker file or can't read it, skip
		}

		var marker WorkbookMarker
		if err := yaml.Unmarshal(data, &marker); err != nil {
			continue // Invalid marker file, skip
		}

		if marker.Workbook.ID == workbookID {
			return filepath.Join(outputDir, entry.Name()), nil
		}
	}

	return "", nil
}

// createDataFolderMarkers creates .scratchmd marker files in each data folder directory
func createDataFolderMarkers(targetDir string, dataFolders []api.DataFolder) error {
	// Build a map from folder name to data folder for quick lookup
	folderMap := make(map[string]api.DataFolder)
	for _, df := range dataFolders {
		folderMap[df.Name] = df
	}

	// Read directories in the target directory
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		return fmt.Errorf("failed to read target directory: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		folderName := entry.Name()

		// Check if this folder matches a data folder
		df, exists := folderMap[folderName]
		if !exists {
			continue // Not a data folder, skip
		}

		// Create .scratchmd marker in the folder
		marker := DataFolderMarker{
			Version: "1",
			DataFolder: DataFolderConfig{
				ID:   df.ID,
				Name: df.Name,
			},
		}

		markerPath := filepath.Join(targetDir, folderName, ".scratchmd")
		markerData, err := yaml.Marshal(&marker)
		if err != nil {
			return fmt.Errorf("failed to marshal marker for %s: %w", folderName, err)
		}

		if err := os.WriteFile(markerPath, markerData, 0644); err != nil {
			return fmt.Errorf("failed to write marker for %s: %w", folderName, err)
		}
	}

	return nil
}
