use super::*;

fn entry(id: &str, service: &str, display_name: &str, dir_name: &str) -> ConnectionEntry {
    ConnectionEntry {
        id: id.to_string(),
        display_name: display_name.to_string(),
        service: service.to_string(),
        repo_path: String::new(),
        dir_name: dir_name.to_string(),
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
