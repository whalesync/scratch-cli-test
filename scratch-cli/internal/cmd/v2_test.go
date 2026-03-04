package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// loadWorkbookMarker
// ---------------------------------------------------------------------------

func TestLoadWorkbookMarker_V1(t *testing.T) {
	dir := t.TempDir()
	content := `version: "1"
workbook:
  id: wkb_abc123
  name: My Workbook
  serverUrl: https://scratch.test
  initializedAt: "2024-01-01T00:00:00Z"
`
	if err := os.WriteFile(filepath.Join(dir, ".scratchmd"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	marker, err := loadWorkbookMarker(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if marker.Workbook.ID != "wkb_abc123" {
		t.Errorf("expected workbook ID wkb_abc123, got %s", marker.Workbook.ID)
	}
	if marker.Workbook.Name != "My Workbook" {
		t.Errorf("expected workbook name 'My Workbook', got %s", marker.Workbook.Name)
	}
	if marker.Workbook.ServerURL != "https://scratch.test" {
		t.Errorf("expected serverUrl https://scratch.test, got %s", marker.Workbook.ServerURL)
	}
}

func TestLoadWorkbookMarker_V2(t *testing.T) {
	dir := t.TempDir()
	content := `version: "2"
workbook:
  id: wkb_v2test
  name: V2 Workbook
  serverUrl: https://scratch.test
  initializedAt: "2024-06-01T00:00:00Z"
`
	if err := os.WriteFile(filepath.Join(dir, ".scratchmd"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	marker, err := loadWorkbookMarker(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if marker.Version != "2" {
		t.Errorf("expected version 2, got %s", marker.Version)
	}
	if marker.Workbook.ID != "wkb_v2test" {
		t.Errorf("expected workbook ID wkb_v2test, got %s", marker.Workbook.ID)
	}
}

func TestLoadWorkbookMarker_RejectsConnectorMarker(t *testing.T) {
	dir := t.TempDir()
	content := `version: "2"
workbook:
  id: wkb_parent
  name: Parent Workbook
connector:
  id: ca_conn1
  displayName: My Airtable
  service: airtable
`
	if err := os.WriteFile(filepath.Join(dir, ".scratchmd"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := loadWorkbookMarker(dir)
	if err == nil {
		t.Fatal("expected error for connector marker, got nil")
	}
	if err.Error() != "marker is a connector marker, not a workbook marker" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

// ---------------------------------------------------------------------------
// loadConnectorMarker
// ---------------------------------------------------------------------------

func TestLoadConnectorMarker_Valid(t *testing.T) {
	dir := t.TempDir()
	content := `version: "2"
workbook:
  id: wkb_parent
  name: Parent Workbook
connector:
  id: ca_conn1
  displayName: My Airtable
  service: airtable
`
	if err := os.WriteFile(filepath.Join(dir, ".scratchmd"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	marker, err := loadConnectorMarker(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if marker.Connector.ID != "ca_conn1" {
		t.Errorf("expected connector ID ca_conn1, got %s", marker.Connector.ID)
	}
	if marker.Connector.DisplayName != "My Airtable" {
		t.Errorf("expected displayName 'My Airtable', got %s", marker.Connector.DisplayName)
	}
	if marker.Workbook.ID != "wkb_parent" {
		t.Errorf("expected workbook ID wkb_parent, got %s", marker.Workbook.ID)
	}
}

func TestLoadConnectorMarker_RejectsWorkbookMarker(t *testing.T) {
	dir := t.TempDir()
	content := `version: "1"
workbook:
  id: wkb_abc123
  name: My Workbook
  serverUrl: https://scratch.test
  initializedAt: "2024-01-01T00:00:00Z"
`
	if err := os.WriteFile(filepath.Join(dir, ".scratchmd"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := loadConnectorMarker(dir)
	if err == nil {
		t.Fatal("expected error for workbook-only marker, got nil")
	}
	if err.Error() != "marker missing connector ID" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

// ---------------------------------------------------------------------------
// findConnectorDirectories
// ---------------------------------------------------------------------------

func TestFindConnectorDirectories_FindsValidDirs(t *testing.T) {
	root := t.TempDir()

	// Create a valid connector subdirectory
	connDir := filepath.Join(root, "my-airtable")
	if err := os.MkdirAll(filepath.Join(connDir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	marker := `version: "2"
workbook:
  id: wkb_parent
  name: Parent
connector:
  id: ca_conn1
  displayName: My Airtable
  service: airtable
`
	if err := os.WriteFile(filepath.Join(connDir, ".scratchmd"), []byte(marker), 0644); err != nil {
		t.Fatal(err)
	}

	dirs, err := findConnectorDirectories(root)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dirs) != 1 {
		t.Fatalf("expected 1 directory, got %d", len(dirs))
	}
	if dirs[0] != connDir {
		t.Errorf("expected %s, got %s", connDir, dirs[0])
	}
}

func TestFindConnectorDirectories_EmptyDir(t *testing.T) {
	root := t.TempDir()

	dirs, err := findConnectorDirectories(root)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dirs) != 0 {
		t.Errorf("expected 0 directories, got %d", len(dirs))
	}
}

func TestFindConnectorDirectories_SkipsInvalidSubdirs(t *testing.T) {
	root := t.TempDir()

	// Subdir with .scratchmd but no .git
	noGit := filepath.Join(root, "no-git")
	if err := os.MkdirAll(noGit, 0755); err != nil {
		t.Fatal(err)
	}
	marker := `version: "2"
workbook:
  id: wkb_parent
  name: Parent
connector:
  id: ca_conn1
  displayName: Conn
  service: airtable
`
	if err := os.WriteFile(filepath.Join(noGit, ".scratchmd"), []byte(marker), 0644); err != nil {
		t.Fatal(err)
	}

	// Subdir with .git but no .scratchmd
	noMarker := filepath.Join(root, "no-marker")
	if err := os.MkdirAll(filepath.Join(noMarker, ".git"), 0755); err != nil {
		t.Fatal(err)
	}

	dirs, err := findConnectorDirectories(root)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dirs) != 0 {
		t.Errorf("expected 0 directories, got %d", len(dirs))
	}
}

// ---------------------------------------------------------------------------
// aggregateDownloadResults
// ---------------------------------------------------------------------------

func TestAggregateDownloadResults_AllUpToDate(t *testing.T) {
	results := []*DownloadResult{
		{Status: "up_to_date", FilesUpdated: 0, Messages: []string{}},
		{Status: "up_to_date", FilesUpdated: 0, Messages: []string{}},
	}

	agg := aggregateDownloadResults(results)
	if agg.Status != "up_to_date" {
		t.Errorf("expected status up_to_date, got %s", agg.Status)
	}
}

func TestAggregateDownloadResults_Mixed(t *testing.T) {
	results := []*DownloadResult{
		{Status: "up_to_date", FilesUpdated: 0, FilesCreated: 1, Messages: []string{"fetched conn A"}},
		{Status: "downloaded", FilesUpdated: 2, FilesCreated: 3, FilesDeleted: 1, Messages: []string{"merged conn B"}},
	}

	agg := aggregateDownloadResults(results)
	if agg.Status != "downloaded" {
		t.Errorf("expected status downloaded, got %s", agg.Status)
	}
	if agg.FilesUpdated != 2 {
		t.Errorf("expected FilesUpdated 2, got %d", agg.FilesUpdated)
	}
	if agg.FilesCreated != 4 {
		t.Errorf("expected FilesCreated 4, got %d", agg.FilesCreated)
	}
	if agg.FilesDeleted != 1 {
		t.Errorf("expected FilesDeleted 1, got %d", agg.FilesDeleted)
	}
	if len(agg.Messages) != 2 {
		t.Errorf("expected 2 messages, got %d", len(agg.Messages))
	}
}

// ---------------------------------------------------------------------------
// aggregateUploadResults
// ---------------------------------------------------------------------------

func TestAggregateUploadResults_AllNoChanges(t *testing.T) {
	results := []*UploadResult{
		{Status: "no_changes", FilesUploaded: 0, Messages: []string{}},
		{Status: "no_changes", FilesUploaded: 0, Messages: []string{}},
	}

	agg := aggregateUploadResults(results)
	if agg.Status != "no_changes" {
		t.Errorf("expected status no_changes, got %s", agg.Status)
	}
}

func TestAggregateUploadResults_Mixed(t *testing.T) {
	results := []*UploadResult{
		{Status: "no_changes", FilesUploaded: 0, Messages: []string{}},
		{Status: "uploaded", FilesUploaded: 5, FilesMerged: 1, FilesDeleted: 2, Messages: []string{"pushed"}},
	}

	agg := aggregateUploadResults(results)
	if agg.Status != "uploaded" {
		t.Errorf("expected status uploaded, got %s", agg.Status)
	}
	if agg.FilesUploaded != 5 {
		t.Errorf("expected FilesUploaded 5, got %d", agg.FilesUploaded)
	}
	if agg.FilesMerged != 1 {
		t.Errorf("expected FilesMerged 1, got %d", agg.FilesMerged)
	}
	if agg.FilesDeleted != 2 {
		t.Errorf("expected FilesDeleted 2, got %d", agg.FilesDeleted)
	}
	if len(agg.Messages) != 1 {
		t.Errorf("expected 1 message, got %d", len(agg.Messages))
	}
}

// ---------------------------------------------------------------------------
// sanitizeFilename
// ---------------------------------------------------------------------------

func TestSanitizeFilename_Normal(t *testing.T) {
	result := sanitizeFilename("my-document.md")
	if result != "my-document.md" {
		t.Errorf("expected 'my-document.md', got '%s'", result)
	}
}

func TestSanitizeFilename_SpecialChars(t *testing.T) {
	result := sanitizeFilename(`file/with\bad:chars*and?more"plus<angle>pipes|here`)
	expected := "file-with-bad-chars-and-more-plus-angle-pipes-here"
	if result != expected {
		t.Errorf("expected '%s', got '%s'", expected, result)
	}
}
