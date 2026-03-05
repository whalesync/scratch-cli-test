package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/spf13/cobra"
	"github.com/whalesync/scratch-cli/internal/config"
	"github.com/whalesync/scratch-cli/internal/merge"
	"golang.org/x/term"
	"gopkg.in/yaml.v3"
)

// ANSI color codes
const (
	colorReset  = "\033[0m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorRed    = "\033[31m"
)

// fileChangeType represents the type of change made to a file
type fileChangeType int

const (
	fileAdded fileChangeType = iota
	fileModified
	fileDeleted
)

// printFileChange prints a color-coded file change line
func printFileChange(path string, changeType fileChangeType) {
	// Check if stdout is a terminal for color support
	useColor := term.IsTerminal(int(os.Stdout.Fd()))

	var label, color string
	switch changeType {
	case fileAdded:
		label = "added"
		color = colorGreen
	case fileModified:
		label = "modified"
		color = colorYellow
	case fileDeleted:
		label = "deleted"
		color = colorRed
	}

	if useColor {
		fmt.Printf("  %s  %s%s%s\n", path, color, label, colorReset)
	} else {
		fmt.Printf("  %s  %s\n", path, label)
	}
}

var filesCmd = &cobra.Command{
	Use:   "files",
	Short: "Manage workspace files",
	Long: `Manage files in a workspace.

Commands:
  files download    Fetch remote changes and merge with local edits
  files upload      Push local changes to the server`,
}

var filesDownloadCmd = &cobra.Command{
	Use:   "download [workspace-id]",
	Short: "Download remote changes and merge with local edits",
	Long: `Fetch the latest changes from the server's dirty branch and three-way
merge them with any local edits.

If run inside a workspace directory (contains .scratchmd marker), the workspace
is detected automatically. Otherwise, pass the workspace ID as an argument.

Examples:
  scratchmd files download
  scratchmd files download abc123`,
	Args: cobra.MaximumNArgs(1),
	RunE: runFilesDownload,
}

var filesUploadCmd = &cobra.Command{
	Use:   "upload [workspace-id]",
	Short: "Push local changes to the server",
	Long: `Upload local changes to the server's dirty branch using three-way merge
with optimistic concurrency. If the remote branch changes during upload, the
operation is retried automatically.

If run inside a workspace directory (contains .scratchmd marker), the workspace
is detected automatically. Otherwise, pass the workspace ID as an argument.

Examples:
  scratchmd files upload
  scratchmd files upload abc123`,
	Args: cobra.MaximumNArgs(1),
	RunE: runFilesUpload,
}

func init() {
	rootCmd.AddCommand(filesCmd)
	filesCmd.AddCommand(filesDownloadCmd)
	filesCmd.AddCommand(filesUploadCmd)

	filesDownloadCmd.Flags().Bool("json", false, "Output as JSON")
	filesUploadCmd.Flags().Bool("json", false, "Output as JSON")
}

// DownloadResult is the JSON output for files download.
type DownloadResult struct {
	Status                string   `json:"status"`
	FilesUpdated          int      `json:"filesUpdated"`
	FilesCreated          int      `json:"filesCreated"`
	FilesDeleted          int      `json:"filesDeleted"`
	FilesMerged           int      `json:"filesMerged"`
	ConflictsAutoResolved int      `json:"conflictsAutoResolved"`
	Messages              []string `json:"messages"`
}

// loadConnectorMarker reads and parses a .scratchmd marker with connector key in a directory.
func loadConnectorMarker(dir string) (*ConnectorMarker, error) {
	data, err := os.ReadFile(filepath.Join(dir, ".scratchmd"))
	if err != nil {
		return nil, err
	}

	var marker ConnectorMarker
	if err := yaml.Unmarshal(data, &marker); err != nil {
		return nil, err
	}

	if marker.Connector.ID == "" {
		return nil, fmt.Errorf("marker missing connector ID")
	}

	return &marker, nil
}

// findConnectorDirectories scans a workbook root for connector subdirectories.
// A connector subdir contains a .scratchmd with connector info and a .git directory.
func findConnectorDirectories(workbookDir string) ([]string, error) {
	entries, err := os.ReadDir(workbookDir)
	if err != nil {
		return nil, err
	}

	var dirs []string
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == ".git" {
			continue
		}
		subDir := filepath.Join(workbookDir, entry.Name())
		// Check for connector marker
		if _, err := loadConnectorMarker(subDir); err != nil {
			continue
		}
		// Check for .git directory
		if info, err := os.Stat(filepath.Join(subDir, ".git")); err != nil || !info.IsDir() {
			continue
		}
		dirs = append(dirs, subDir)
	}
	return dirs, nil
}

// downloadSingleRepo performs a download (fetch + three-way merge) for a single git repo directory.
func downloadSingleRepo(repoDir string, creds *config.GlobalCredentials) (*DownloadResult, error) {
	repo, err := git.PlainOpen(repoDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open git repository at %s: %w", repoDir, err)
	}

	headRef, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("failed to get HEAD: %w", err)
	}
	baseHash := headRef.Hash()

	gitAuth := &APITokenAuth{Token: creds.APIToken}

	err = repo.Fetch(&git.FetchOptions{
		RemoteName: "origin",
		RefSpecs: []gitconfig.RefSpec{
			"refs/heads/dirty:refs/remotes/origin/dirty",
		},
		Auth:  gitAuth,
		Depth: 0,
		Force: true,
	})
	if err != nil && err != git.NoErrAlreadyUpToDate {
		return nil, fmt.Errorf("failed to fetch remote changes: %w", err)
	}

	remoteRef, err := repo.Reference(plumbing.NewRemoteReferenceName("origin", "dirty"), true)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve remote dirty branch: %w", err)
	}
	remoteHash := remoteRef.Hash()

	if baseHash == remoteHash {
		return &DownloadResult{Status: "up_to_date"}, nil
	}

	baseMap, err := treeToFileMap(repo, baseHash)
	if err != nil {
		return nil, fmt.Errorf("failed to read base tree: %w", err)
	}

	remoteMap, err := treeToFileMap(repo, remoteHash)
	if err != nil {
		return nil, fmt.Errorf("failed to read remote tree: %w", err)
	}

	localMap, err := diskToFileMap(repoDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read local files: %w", err)
	}

	actions := merge.ComputeMergeActions(baseMap, localMap, remoteMap)

	stash := make(map[string][]byte)
	var deletions []string
	var messages []string
	result := DownloadResult{Status: "downloaded"}

	for _, act := range actions {
		switch act.Action {
		case merge.ActionKeepLocal:
			if act.Local != nil {
				stash[act.Path] = act.Local
			}
		case merge.ActionWriteRemote:
			if act.Base == nil {
				result.FilesCreated++
			} else {
				result.FilesUpdated++
			}
		case merge.ActionDelete:
			result.FilesDeleted++
			deletions = append(deletions, act.Path)
			if act.WarningMsg != "" {
				messages = append(messages, act.WarningMsg)
			}
		case merge.ActionMerge:
			merged := mergeFileContent(act.Path, act.Base, act.Local, act.Remote)
			stash[act.Path] = merged
			result.FilesMerged++
			if act.Base != nil {
				result.ConflictsAutoResolved++
			}
		}
	}

	// Stash .scratchmd markers
	markerPath := filepath.Join(repoDir, ".scratchmd")
	markerData, readErr := os.ReadFile(markerPath)
	if readErr == nil {
		stash[".scratchmd"] = markerData
	}
	stashDataFolderMarkers(repoDir, stash)

	wt, err := repo.Worktree()
	if err != nil {
		return nil, fmt.Errorf("failed to get worktree: %w", err)
	}

	err = wt.Reset(&git.ResetOptions{
		Commit: remoteHash,
		Mode:   git.HardReset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to reset to remote state: %w", err)
	}

	for relPath, content := range stash {
		fullPath := filepath.Join(repoDir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			return nil, fmt.Errorf("failed to create directory for %s: %w", relPath, err)
		}
		if err := os.WriteFile(fullPath, content, 0644); err != nil {
			return nil, fmt.Errorf("failed to write %s: %w", relPath, err)
		}
	}

	for _, relPath := range deletions {
		fullPath := filepath.Join(repoDir, filepath.FromSlash(relPath))
		_ = os.Remove(fullPath)
	}

	if messages == nil {
		messages = []string{}
	}
	result.Messages = messages
	return &result, nil
}

// aggregateDownloadResults combines multiple DownloadResults into one.
func aggregateDownloadResults(results []*DownloadResult) *DownloadResult {
	agg := &DownloadResult{Status: "up_to_date", Messages: []string{}}
	for _, r := range results {
		if r.Status == "downloaded" {
			agg.Status = "downloaded"
		}
		agg.FilesUpdated += r.FilesUpdated
		agg.FilesCreated += r.FilesCreated
		agg.FilesDeleted += r.FilesDeleted
		agg.FilesMerged += r.FilesMerged
		agg.ConflictsAutoResolved += r.ConflictsAutoResolved
		agg.Messages = append(agg.Messages, r.Messages...)
	}
	return agg
}

func runFilesDownload(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	// 1. Find the workbook directory.
	var workbookDir string
	var marker WorkbookMarker

	// Determine workbook ID from args or --workbook flag (set by linked parent command).
	var workbookID string
	if len(args) > 0 {
		workbookID = args[0]
	} else if flag := cmd.Flags().Lookup("workspace"); flag != nil && flag.Value.String() != "" {
		workbookID = flag.Value.String()
	} else if flag := cmd.Flags().Lookup("workbook"); flag != nil && flag.Value.String() != "" {
		workbookID = flag.Value.String()
	}

	if workbookID != "" {
		// Check if we're already inside this workbook directory.
		dir, m, err := findWorkbookMarkerUpward(".")
		if err == nil && dir != "" && m.Workbook.ID == workbookID {
			workbookDir = dir
			marker = *m
		} else {
			// Scan current directory children.
			dir, err := findExistingWorkbookMarker(".", workbookID)
			if err != nil {
				return fmt.Errorf("failed to find workspace: %w", err)
			}
			if dir == "" {
				return fmt.Errorf("workspace %s not found in current directory. Run 'scratchmd workspaces init %s' first", workbookID, workbookID)
			}
			workbookDir = dir
			m, err := loadWorkbookMarker(workbookDir)
			if err != nil {
				return fmt.Errorf("failed to read marker: %w", err)
			}
			marker = *m
		}
	} else {
		// Check if we're inside a V2 connector subdirectory first.
		connDir, connMarker, _ := findConnectorMarkerUpward(".")
		if connDir != "" && connMarker != nil {
			// We're inside a connector subdir — download just this repo.
			return runSingleRepoDownload(connDir, jsonOutput)
		}

		// Auto-detect from current directory upward.
		dir, m, err := findWorkbookMarkerUpward(".")
		if err != nil {
			return fmt.Errorf("failed to detect workspace: %w", err)
		}
		if dir == "" {
			return fmt.Errorf("not inside a workspace directory. Run from a workspace directory or pass a workspace ID")
		}
		workbookDir = dir
		marker = *m
	}

	serverURL := marker.Workbook.ServerURL
	if serverURL == "" {
		serverURL = getServerURL()
	}

	if !config.IsLoggedIn(serverURL) {
		return fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return fmt.Errorf("failed to load credentials: %w", err)
	}

	// V2 workbooks: iterate connector subdirectories
	if marker.Version == "2" {
		return runV2Download(workbookDir, creds, jsonOutput)
	}

	// V1: single repo download
	result, err := downloadSingleRepo(workbookDir, creds)
	if err != nil {
		return err
	}
	return printDownloadResult(result, jsonOutput)
}

// runV2Download downloads all connector repos in a V2 workbook.
func runV2Download(workbookDir string, creds *config.GlobalCredentials, jsonOutput bool) error {
	connDirs, err := findConnectorDirectories(workbookDir)
	if err != nil {
		return fmt.Errorf("failed to find connector directories: %w", err)
	}

	if len(connDirs) == 0 {
		if jsonOutput {
			result := DownloadResult{Status: "up_to_date", Messages: []string{}}
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(result)
		}
		fmt.Println("No connector directories found. Run 'scratchmd workspaces init' first.")
		return nil
	}

	var results []*DownloadResult
	for _, dir := range connDirs {
		if !jsonOutput {
			fmt.Printf("Downloading %s...\n", filepath.Base(dir))
		}
		r, err := downloadSingleRepo(dir, creds)
		if err != nil {
			return fmt.Errorf("failed to download %s: %w", filepath.Base(dir), err)
		}
		results = append(results, r)
	}

	agg := aggregateDownloadResults(results)
	return printDownloadResult(agg, jsonOutput)
}

// runSingleRepoDownload downloads a single connector repo (when cwd is inside one).
func runSingleRepoDownload(repoDir string, jsonOutput bool) error {
	// Read the connector marker to find the server URL
	connMarker, _ := loadConnectorMarker(repoDir)
	serverURL := getServerURL()

	// Try to get server URL from parent workbook marker
	parent := filepath.Dir(repoDir)
	if wbMarker, err := loadWorkbookMarker(parent); err == nil && wbMarker.Workbook.ServerURL != "" {
		serverURL = wbMarker.Workbook.ServerURL
	} else if connMarker != nil {
		// Connector marker doesn't store server URL, use default
		_ = connMarker
	}

	if !config.IsLoggedIn(serverURL) {
		return fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return fmt.Errorf("failed to load credentials: %w", err)
	}

	result, dlErr := downloadSingleRepo(repoDir, creds)
	if dlErr != nil {
		return dlErr
	}
	return printDownloadResult(result, jsonOutput)
}

// printDownloadResult outputs a DownloadResult in JSON or human-readable format.
func printDownloadResult(result *DownloadResult, jsonOutput bool) error {
	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	totalChanges := result.FilesCreated + result.FilesUpdated + result.FilesMerged + result.FilesDeleted
	if totalChanges == 0 {
		if result.Status == "up_to_date" {
			fmt.Println("Already up to date.")
		} else {
			fmt.Println("No changes.")
		}
		return nil
	}

	fmt.Println()
	var summary []string
	if result.FilesCreated > 0 {
		summary = append(summary, fmt.Sprintf("%d added", result.FilesCreated))
	}
	if result.FilesUpdated > 0 {
		summary = append(summary, fmt.Sprintf("%d modified", result.FilesUpdated))
	}
	if result.FilesMerged > 0 {
		summary = append(summary, fmt.Sprintf("%d merged", result.FilesMerged))
	}
	if result.FilesDeleted > 0 {
		summary = append(summary, fmt.Sprintf("%d deleted", result.FilesDeleted))
	}
	if len(summary) > 0 {
		fmt.Println(strings.Join(summary, ", "))
	}

	for _, msg := range result.Messages {
		fmt.Printf("Warning: %s\n", msg)
	}

	return nil
}

// findConnectorMarkerUpward walks the current directory and parents looking for
// a .scratchmd marker with a connector key.
func findConnectorMarkerUpward(startDir string) (string, *ConnectorMarker, error) {
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return "", nil, err
	}

	for {
		m, err := loadConnectorMarker(dir)
		if err == nil && m != nil {
			return dir, m, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return "", nil, nil
}

// UploadResult is the JSON output for files upload.
type UploadResult struct {
	Status                string   `json:"status"` // "uploaded" | "no_changes" | "up_to_date"
	FilesUploaded         int      `json:"filesUploaded"`
	FilesMerged           int      `json:"filesMerged"`
	FilesDeleted          int      `json:"filesDeleted"`
	ConflictsAutoResolved int      `json:"conflictsAutoResolved"`
	Retries               int      `json:"retries"`
	Messages              []string `json:"messages"`
}

// fileMapEqual returns true if two FileMaps have identical keys and content.
func fileMapEqual(a, b merge.FileMap) bool {
	if len(a) != len(b) {
		return false
	}
	for k, av := range a {
		bv, ok := b[k]
		if !ok || !bytes.Equal(av, bv) {
			return false
		}
	}
	return true
}

// uploadSingleRepo performs an upload (merge + commit + push) for a single git repo directory.
func uploadSingleRepo(repoDir string, creds *config.GlobalCredentials) (*UploadResult, error) {
	repo, err := git.PlainOpen(repoDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open git repository at %s: %w", repoDir, err)
	}

	headRef, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("failed to get HEAD: %w", err)
	}
	originalBaseHash := headRef.Hash()

	baseMap, err := treeToFileMap(repo, originalBaseHash)
	if err != nil {
		return nil, fmt.Errorf("failed to read base tree: %w", err)
	}

	localMap, err := diskToFileMap(repoDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read local files: %w", err)
	}

	if fileMapEqual(baseMap, localMap) {
		return &UploadResult{Status: "no_changes", Messages: []string{}}, nil
	}

	gitAuth := &APITokenAuth{Token: creds.APIToken}
	authorEmail := creds.Email
	if authorEmail == "" {
		authorEmail = "cli@scratch.md"
	}

	const maxRetries = 5

	for attempt := 0; attempt < maxRetries; attempt++ {
		err = repo.Fetch(&git.FetchOptions{
			RemoteName: "origin",
			RefSpecs: []gitconfig.RefSpec{
				"refs/heads/dirty:refs/remotes/origin/dirty",
			},
			Auth:  gitAuth,
			Depth: 0,
			Force: true,
		})
		if err != nil && err != git.NoErrAlreadyUpToDate {
			return nil, fmt.Errorf("failed to fetch remote changes: %w", err)
		}

		remoteRef, err := repo.Reference(plumbing.NewRemoteReferenceName("origin", "dirty"), true)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve remote dirty branch: %w", err)
		}
		remoteHash := remoteRef.Hash()

		remoteMap, err := treeToFileMap(repo, remoteHash)
		if err != nil {
			return nil, fmt.Errorf("failed to read remote tree: %w", err)
		}

		actions := merge.ComputeMergeActions(baseMap, localMap, remoteMap)

		mergedMap := make(merge.FileMap)
		var messages []string
		result := UploadResult{Status: "uploaded", Retries: attempt, Messages: []string{}}

		for _, act := range actions {
			switch act.Action {
			case merge.ActionKeepLocal:
				if act.Local != nil {
					mergedMap[act.Path] = act.Local
					remoteContent, inRemote := remoteMap[act.Path]
					if !inRemote {
						result.FilesUploaded++
					} else if !bytes.Equal(act.Local, remoteContent) {
						result.FilesUploaded++
					}
				}
			case merge.ActionWriteRemote:
				if act.Remote != nil {
					mergedMap[act.Path] = act.Remote
				}
			case merge.ActionDelete:
				_, inRemote := remoteMap[act.Path]
				if inRemote {
					result.FilesDeleted++
				}
				if act.WarningMsg != "" {
					messages = append(messages, act.WarningMsg)
				}
			case merge.ActionMerge:
				merged := mergeFileContent(act.Path, act.Base, act.Local, act.Remote)
				mergedMap[act.Path] = merged
				result.FilesMerged++
				if act.Base != nil {
					result.ConflictsAutoResolved++
				}
			}
		}

		if messages != nil {
			result.Messages = messages
		}

		if fileMapEqual(mergedMap, remoteMap) {
			return &UploadResult{Status: "up_to_date", Messages: []string{}}, nil
		}

		// Stash .scratchmd markers
		markerStash := make(map[string][]byte)
		markerPath := filepath.Join(repoDir, ".scratchmd")
		markerData, readErr := os.ReadFile(markerPath)
		if readErr == nil {
			markerStash[".scratchmd"] = markerData
		}
		stashDataFolderMarkers(repoDir, markerStash)

		wt, err := repo.Worktree()
		if err != nil {
			restoreMarkers(repoDir, markerStash)
			return nil, fmt.Errorf("failed to get worktree: %w", err)
		}

		err = wt.Reset(&git.ResetOptions{
			Commit: remoteHash,
			Mode:   git.HardReset,
		})
		if err != nil {
			restoreMarkers(repoDir, markerStash)
			return nil, fmt.Errorf("failed to reset to remote state: %w", err)
		}

		for relPath, content := range mergedMap {
			remoteContent, inRemote := remoteMap[relPath]
			if inRemote && bytes.Equal(content, remoteContent) {
				continue
			}
			fullPath := filepath.Join(repoDir, filepath.FromSlash(relPath))
			if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
				restoreMarkers(repoDir, markerStash)
				return nil, fmt.Errorf("failed to create directory for %s: %w", relPath, err)
			}
			if err := os.WriteFile(fullPath, content, 0644); err != nil {
				restoreMarkers(repoDir, markerStash)
				return nil, fmt.Errorf("failed to write %s: %w", relPath, err)
			}
		}

		for relPath := range remoteMap {
			if _, inMerged := mergedMap[relPath]; !inMerged {
				fullPath := filepath.Join(repoDir, filepath.FromSlash(relPath))
				_ = os.Remove(fullPath)
			}
		}

		if err := wt.AddWithOptions(&git.AddOptions{All: true}); err != nil {
			restoreMarkers(repoDir, markerStash)
			return nil, fmt.Errorf("failed to stage changes: %w", err)
		}

		commitTime := time.Now()
		_, err = wt.Commit("Upload from Scratch CLI", &git.CommitOptions{
			Author: &object.Signature{
				Name:  "Scratch CLI",
				Email: authorEmail,
				When:  commitTime,
			},
		})
		if err != nil {
			restoreMarkers(repoDir, markerStash)
			return nil, fmt.Errorf("failed to commit: %w", err)
		}

		err = repo.Push(&git.PushOptions{
			RemoteName: "origin",
			RefSpecs: []gitconfig.RefSpec{
				"refs/heads/dirty:refs/heads/dirty",
			},
			Auth: gitAuth,
		})

		if err == nil {
			restoreMarkers(repoDir, markerStash)
			return &result, nil
		}

		if err == git.ErrNonFastForwardUpdate {
			restoreMarkers(repoDir, markerStash)
			continue
		}

		restoreMarkers(repoDir, markerStash)
		return nil, fmt.Errorf("failed to push: %w", err)
	}

	return nil, fmt.Errorf("upload failed after %d attempts due to concurrent changes on the server", maxRetries)
}

// aggregateUploadResults combines multiple UploadResults into one.
func aggregateUploadResults(results []*UploadResult) *UploadResult {
	agg := &UploadResult{Status: "no_changes", Messages: []string{}}
	for _, r := range results {
		if r.Status == "uploaded" {
			agg.Status = "uploaded"
		}
		agg.FilesUploaded += r.FilesUploaded
		agg.FilesMerged += r.FilesMerged
		agg.FilesDeleted += r.FilesDeleted
		agg.ConflictsAutoResolved += r.ConflictsAutoResolved
		agg.Retries += r.Retries
		agg.Messages = append(agg.Messages, r.Messages...)
	}
	return agg
}

func runFilesUpload(cmd *cobra.Command, args []string) error {
	jsonOutput, _ := cmd.Flags().GetBool("json")

	// 1. Find the workbook directory.
	var workbookDir string
	var marker WorkbookMarker

	if len(args) > 0 {
		dir, err := findExistingWorkbookMarker(".", args[0])
		if err != nil {
			return fmt.Errorf("failed to find workspace: %w", err)
		}
		if dir == "" {
			return fmt.Errorf("workspace %s not found in current directory. Run 'scratchmd workspaces init %s' first", args[0], args[0])
		}
		workbookDir = dir
		m, err := loadWorkbookMarker(workbookDir)
		if err != nil {
			return fmt.Errorf("failed to read marker: %w", err)
		}
		marker = *m
	} else {
		// Check if we're inside a V2 connector subdirectory first.
		connDir, connMarker, _ := findConnectorMarkerUpward(".")
		if connDir != "" && connMarker != nil {
			return runSingleRepoUpload(connDir, jsonOutput)
		}

		dir, m, err := findWorkbookMarkerUpward(".")
		if err != nil {
			return fmt.Errorf("failed to detect workspace: %w", err)
		}
		if dir == "" {
			return fmt.Errorf("not inside a workspace directory. Run from a workspace directory or pass a workspace ID")
		}
		workbookDir = dir
		marker = *m
	}

	serverURL := marker.Workbook.ServerURL
	if serverURL == "" {
		serverURL = getServerURL()
	}

	if !config.IsLoggedIn(serverURL) {
		return fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return fmt.Errorf("failed to load credentials: %w", err)
	}

	// V2 workbooks: iterate connector subdirectories
	if marker.Version == "2" {
		return runV2Upload(workbookDir, creds, jsonOutput)
	}

	// V1: single repo upload
	result, err := uploadSingleRepo(workbookDir, creds)
	if err != nil {
		return err
	}
	return printUploadResult(result, jsonOutput)
}

// runV2Upload uploads all connector repos in a V2 workbook.
func runV2Upload(workbookDir string, creds *config.GlobalCredentials, jsonOutput bool) error {
	connDirs, err := findConnectorDirectories(workbookDir)
	if err != nil {
		return fmt.Errorf("failed to find connector directories: %w", err)
	}

	if len(connDirs) == 0 {
		if jsonOutput {
			result := UploadResult{Status: "no_changes", Messages: []string{}}
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(result)
		}
		fmt.Println("No connector directories found.")
		return nil
	}

	var results []*UploadResult
	for _, dir := range connDirs {
		if !jsonOutput {
			fmt.Printf("Uploading %s...\n", filepath.Base(dir))
		}
		r, err := uploadSingleRepo(dir, creds)
		if err != nil {
			return fmt.Errorf("failed to upload %s: %w", filepath.Base(dir), err)
		}
		results = append(results, r)
	}

	agg := aggregateUploadResults(results)
	return printUploadResult(agg, jsonOutput)
}

// runSingleRepoUpload uploads a single connector repo (when cwd is inside one).
func runSingleRepoUpload(repoDir string, jsonOutput bool) error {
	serverURL := getServerURL()

	// Try to get server URL from parent workbook marker
	parent := filepath.Dir(repoDir)
	if wbMarker, err := loadWorkbookMarker(parent); err == nil && wbMarker.Workbook.ServerURL != "" {
		serverURL = wbMarker.Workbook.ServerURL
	}

	if !config.IsLoggedIn(serverURL) {
		return fmt.Errorf("not logged in. Run 'scratchmd auth login' first")
	}

	creds, err := config.LoadGlobalCredentials(serverURL)
	if err != nil {
		return fmt.Errorf("failed to load credentials: %w", err)
	}

	result, err := uploadSingleRepo(repoDir, creds)
	if err != nil {
		return err
	}
	return printUploadResult(result, jsonOutput)
}

// printUploadResult outputs an UploadResult in JSON or human-readable format.
func printUploadResult(result *UploadResult, jsonOutput bool) error {
	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}

	if result.Status == "no_changes" {
		fmt.Println("No local changes to upload.")
		return nil
	}
	if result.Status == "up_to_date" {
		fmt.Println("Remote already has all local changes.")
		return nil
	}

	totalChanges := result.FilesUploaded + result.FilesMerged + result.FilesDeleted
	if totalChanges == 0 {
		fmt.Println("No changes.")
		return nil
	}

	fmt.Println()
	var summary []string
	if result.FilesUploaded > 0 {
		summary = append(summary, fmt.Sprintf("%d uploaded", result.FilesUploaded))
	}
	if result.FilesMerged > 0 {
		summary = append(summary, fmt.Sprintf("%d merged", result.FilesMerged))
	}
	if result.FilesDeleted > 0 {
		summary = append(summary, fmt.Sprintf("%d deleted", result.FilesDeleted))
	}
	if len(summary) > 0 {
		fmt.Println(strings.Join(summary, ", "))
	}

	for _, msg := range result.Messages {
		fmt.Printf("Warning: %s\n", msg)
	}

	return nil
}

// restoreMarkers writes back stashed .scratchmd marker files.
func restoreMarkers(workbookDir string, stash map[string][]byte) {
	for relPath, content := range stash {
		fullPath := filepath.Join(workbookDir, filepath.FromSlash(relPath))
		_ = os.MkdirAll(filepath.Dir(fullPath), 0755)
		_ = os.WriteFile(fullPath, content, 0644)
	}
}

// findWorkbookMarkerUpward walks the current directory and parents looking for
// a .scratchmd marker file. Returns the directory path and parsed marker.
func findWorkbookMarkerUpward(startDir string) (string, *WorkbookMarker, error) {
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return "", nil, err
	}

	for {
		m, err := loadWorkbookMarker(dir)
		if err == nil && m != nil {
			return dir, m, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break // Reached filesystem root.
		}
		dir = parent
	}

	return "", nil, nil
}

// loadWorkbookMarker reads and parses the .scratchmd marker in a directory.
// Returns nil if the marker is a connector marker (not a workbook marker).
func loadWorkbookMarker(dir string) (*WorkbookMarker, error) {
	data, err := os.ReadFile(filepath.Join(dir, ".scratchmd"))
	if err != nil {
		return nil, err
	}

	var marker WorkbookMarker
	if err := yaml.Unmarshal(data, &marker); err != nil {
		return nil, err
	}

	if marker.Workbook.ID == "" {
		return nil, fmt.Errorf("marker missing workbook ID")
	}

	// Distinguish workbook markers from connector markers: connector markers
	// also have workbook.id but lack serverUrl/initializedAt. We try to parse
	// as a ConnectorMarker; if it succeeds, this is NOT a workbook marker.
	var connCheck ConnectorMarker
	if err := yaml.Unmarshal(data, &connCheck); err == nil && connCheck.Connector.ID != "" {
		return nil, fmt.Errorf("marker is a connector marker, not a workbook marker")
	}

	return &marker, nil
}

// treeToFileMap reads all files from a commit's tree into a FileMap.
func treeToFileMap(repo *git.Repository, commitHash plumbing.Hash) (merge.FileMap, error) {
	commitObj, err := repo.CommitObject(commitHash)
	if err != nil {
		return nil, fmt.Errorf("failed to get commit %s: %w", commitHash, err)
	}

	tree, err := commitObj.Tree()
	if err != nil {
		return nil, fmt.Errorf("failed to get tree: %w", err)
	}

	fm := make(merge.FileMap)
	err = tree.Files().ForEach(func(f *object.File) error {
		content, err := f.Contents()
		if err != nil {
			return err
		}
		data := []byte(content)
		// Normalize CRLF to LF so git tree content matches disk content.
		if !merge.IsBinary(data) {
			data = merge.NormalizeCRLF(data)
		}
		fm[filepath.ToSlash(f.Name)] = data
		return nil
	})
	if err != nil {
		return nil, err
	}

	return fm, nil
}

// diskToFileMap reads all files from a directory into a FileMap, skipping
// .git and .scratchmd entries. Files are read in parallel for performance.
func diskToFileMap(rootDir string) (merge.FileMap, error) {
	absRoot, err := filepath.Abs(rootDir)
	if err != nil {
		return nil, err
	}

	// Pass 1: collect file paths (fast, minimal I/O).
	type fileEntry struct {
		absPath string
		relPath string
	}
	var files []fileEntry

	err = filepath.Walk(absRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		name := info.Name()
		if info.IsDir() && name == ".git" {
			return filepath.SkipDir
		}
		if name == ".scratchmd" || name == ".schema.json" || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			return err
		}
		files = append(files, fileEntry{absPath: path, relPath: filepath.ToSlash(rel)})
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Pass 2: read files in parallel using a worker pool.
	type readResult struct {
		relPath string
		data    []byte
		err     error
	}

	numWorkers := runtime.NumCPU()
	if numWorkers > len(files) {
		numWorkers = len(files)
	}
	if numWorkers < 1 {
		numWorkers = 1
	}

	jobs := make(chan fileEntry, len(files))
	results := make(chan readResult, len(files))

	for w := 0; w < numWorkers; w++ {
		go func() {
			for f := range jobs {
				data, err := os.ReadFile(f.absPath)
				if err != nil {
					results <- readResult{err: err}
					continue
				}
				// Normalize CRLF to LF for text files so disk content on Windows
				// matches LF-only content from git objects.
				if !merge.IsBinary(data) {
					data = merge.NormalizeCRLF(data)
				}
				results <- readResult{relPath: f.relPath, data: data}
			}
		}()
	}

	for _, f := range files {
		jobs <- f
	}
	close(jobs)

	fm := make(merge.FileMap, len(files))
	for range files {
		r := <-results
		if r.err != nil {
			return nil, r.err
		}
		fm[r.relPath] = r.data
	}

	return fm, nil
}

// mergeFileContent picks the right merge strategy based on file type.
func mergeFileContent(path string, base, local, remote []byte) []byte {
	// Binary files — local wins atomically.
	if (local != nil && merge.IsBinary(local)) || (remote != nil && merge.IsBinary(remote)) {
		if local != nil {
			return local
		}
		return remote
	}

	// Text files (including JSON) — line-level merge preserves formatting.
	return merge.MergeText(base, local, remote)
}

// stashDataFolderMarkers finds and stashes .scratchmd markers in subdirectories.
func stashDataFolderMarkers(rootDir string, stash map[string][]byte) {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == ".git" {
			continue
		}

		markerPath := filepath.Join(rootDir, entry.Name(), ".scratchmd")
		data, err := os.ReadFile(markerPath)
		if err != nil {
			continue
		}

		relPath := filepath.ToSlash(filepath.Join(entry.Name(), ".scratchmd"))
		stash[relPath] = data
	}
}
