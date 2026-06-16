use super::*;

fn entry(id: &str, service: &str, display_name: &str, dir_name: &str) -> ConnectionEntry {
    ConnectionEntry {
        id: id.to_string(),
        display_name: display_name.to_string(),
        service: service.to_string(),
        repo_path: String::new(),
        dir_name: dir_name.to_string(),
        structure_version: 0,
    }
}

#[test]
fn connector_dir_name_uses_display_name_only() {
    assert_eq!(connector_dir_name("My Base"), "My Base");
}

#[test]
fn connector_dir_name_sanitizes_special_chars() {
    assert_eq!(connector_dir_name("foo/bar:baz"), "foo-bar-baz");
}

#[test]
fn connector_dir_name_legacy_prefixes_service() {
    assert_eq!(
        connector_dir_name_legacy("Airtable", "My Base"),
        "Airtable - My Base"
    );
}

#[test]
fn connector_dir_name_legacy_sanitizes_special_chars() {
    assert_eq!(
        connector_dir_name_legacy("Air/table", "My:Base"),
        "Air-table - My-Base"
    );
}

#[test]
fn workspace_uses_legacy_naming_false_for_empty_workspace() {
    assert!(!workspace_uses_legacy_naming(&[]));
}

#[test]
fn workspace_uses_legacy_naming_false_for_new_pattern_only() {
    let conns = vec![
        entry("ca_1", "Airtable", "My Base", "My Base"),
        entry("ca_2", "Webflow", "Marketing Site", "Marketing Site"),
    ];
    assert!(!workspace_uses_legacy_naming(&conns));
}

#[test]
fn workspace_uses_legacy_naming_true_for_legacy_pattern_only() {
    let conns = vec![
        entry("ca_1", "Airtable", "My Base", "Airtable - My Base"),
        entry(
            "ca_2",
            "Webflow",
            "Marketing Site",
            "Webflow - Marketing Site",
        ),
    ];
    assert!(workspace_uses_legacy_naming(&conns));
}

#[test]
fn workspace_uses_legacy_naming_true_when_any_entry_is_legacy() {
    let conns = vec![
        entry("ca_1", "Airtable", "My Base", "My Base"),
        entry(
            "ca_2",
            "Webflow",
            "Marketing Site",
            "Webflow - Marketing Site",
        ),
    ];
    assert!(workspace_uses_legacy_naming(&conns));
}

#[test]
fn workspace_uses_legacy_naming_false_for_manually_renamed_dirs() {
    let conns = vec![entry(
        "ca_1",
        "Airtable",
        "My Base",
        "totally-custom-folder",
    )];
    assert!(!workspace_uses_legacy_naming(&conns));
}

#[test]
fn structure_version_round_trips_through_write_and_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = entry("ca_1", "Webflow", "Marketing Site", "Marketing Site");
    conn.structure_version = 2;
    write_workspace(
        dir.path(),
        "wkb_1",
        "My Workbook",
        "org_1",
        "http://localhost",
        &[conn],
    )
    .unwrap();

    let Marker::Workspace(read_back) = read(&marker_path(dir.path())).unwrap() else {
        panic!("expected a workspace marker");
    };
    assert_eq!(read_back.connections.len(), 1);
    assert_eq!(read_back.connections[0].structure_version, 2);
}

#[test]
fn structure_version_absent_in_marker_deserializes_to_zero() {
    // A marker written before the structureVersion field existed must still load
    // (back-compat) with structure_version defaulting to 0 ("not recorded"), so
    // drift detection never fires on it.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".scratch")).unwrap();
    let legacy_yaml = "\
version: '3'
workbook:
  id: wkb_1
  name: My Workbook
  orgId: org_1
  serverUrl: http://localhost
  initializedAt: '2026-01-01T00:00:00Z'
connections:
  - id: ca_1
    displayName: Marketing Site
    service: Webflow
    repoPath: org_1/wkb_1/ca_1
    dirName: Marketing Site
";
    std::fs::write(marker_path(dir.path()), legacy_yaml).unwrap();

    let Marker::Workspace(read_back) = read(&marker_path(dir.path())).unwrap() else {
        panic!("expected a workspace marker");
    };
    assert_eq!(read_back.connections.len(), 1);
    assert_eq!(read_back.connections[0].structure_version, 0);
}
