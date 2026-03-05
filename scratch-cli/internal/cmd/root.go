// Package cmd contains all CLI command definitions for scratchmd.
package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/whalesync/scratch-cli/internal/api"
	"github.com/whalesync/scratch-cli/internal/config"
)

// Version information (set at build time via ldflags)
var (
	version   = "dev"
	commit    = "none"
	buildDate = "unknown"
)

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:   "scratchmd",
	Short: "Command-line tool for Scratch.md",
	Long: `scratchmd is the command-line tool for Scratch.md.

══════════════════════════════════════════════════════════════════════════════
                              AUTHENTICATION
══════════════════════════════════════════════════════════════════════════════

  auth login                     Authenticate with Scratch.md
  auth logout                    End current session
  auth status                    Show current auth state

══════════════════════════════════════════════════════════════════════════════
                               WORKSPACES
══════════════════════════════════════════════════════════════════════════════

  workspaces list                List all workspaces
  workspaces create              Create a new workspace
  workspaces show <id>           Show workspace details
  workspaces delete <id>         Delete a workspace
  workspaces init <id>           Clone workspace files to local directory

══════════════════════════════════════════════════════════════════════════════
                                  FILES
══════════════════════════════════════════════════════════════════════════════

  files download                 Download remote changes and merge locally
  files upload                   Upload local changes to the server

══════════════════════════════════════════════════════════════════════════════
                               CONNECTIONS
══════════════════════════════════════════════════════════════════════════════

  connections list               List all connections in the workspace
  connections add                Authorize a new connection
  connections show <id>          Show connection details
  connections remove <id>        Delete a connection

══════════════════════════════════════════════════════════════════════════════
                              LINKED TABLES
══════════════════════════════════════════════════════════════════════════════

  linked available               List available tables from connections
  linked list                    List linked tables in a workspace
  linked add                     Link a new table to a workspace
  linked remove [id]             Unlink a table from a workspace
  linked show [id]               Show linked table details
  linked pull [id]               Pull CRM changes into the workspace
  linked publish [id]            Publish workspace changes to the CRM

══════════════════════════════════════════════════════════════════════════════
                                 SYNCS
══════════════════════════════════════════════════════════════════════════════

  syncs list                     List sync configurations
  syncs show <id>                Show sync details
  syncs create                   Create a new sync configuration
  syncs update <id>              Update a sync configuration
  syncs delete <id>              Delete a sync
  syncs run <id>                 Execute a sync

══════════════════════════════════════════════════════════════════════════════`,
	Version: version,
	// Silence usage on errors - we'll handle our own error messages
	SilenceUsage: true,
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() error {
	return rootCmd.Execute()
}

func init() {
	// Set version template to include build info
	rootCmd.SetVersionTemplate(fmt.Sprintf(`scratchmd version {{.Version}}
commit: %s
built: %s
`, commit, buildDate))

	// Global flags that apply to all commands
	rootCmd.PersistentFlags().BoolP("verbose", "v", false, "Enable verbose output")
	rootCmd.PersistentFlags().String("config", "", "Config file path (default: .scratchmd.config.yaml)")

	// Config overrides
	rootCmd.PersistentFlags().StringVar(&config.Overrides.Settings.ScratchServerURL, "scratch-url", "", "Override scratch server URL")
}

// SetVersionInfo sets the version information for the CLI.
// Called from main with values injected at build time.
func SetVersionInfo(v, c, d string) {
	version = v
	commit = c
	buildDate = d
	// Also set the API package version for request headers
	api.Version = v
}

// GetVersion returns the current CLI version.
func GetVersion() string {
	return version
}

// Helper function to exit with error message
func exitWithError(msg string) {
	fmt.Fprintln(os.Stderr, "Error:", msg)
	os.Exit(1)
}
