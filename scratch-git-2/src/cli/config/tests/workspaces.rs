use super::*;
use tempfile::TempDir;

#[test]
fn upsert_overwrites_existing_workspace_path() {
    let tmp = TempDir::new().unwrap();
    let registry = tmp.path().join("workspaces.yaml");
    let path_one = tmp.path().join("one");
    let path_two = tmp.path().join("two");
    std::fs::create_dir_all(&path_one).unwrap();
    std::fs::create_dir_all(&path_two).unwrap();
    std::fs::create_dir_all(path_one.join(".scratch")).unwrap();
    std::fs::create_dir_all(path_two.join(".scratch")).unwrap();
    std::fs::write(path_one.join(".scratch/.scratchmd"), "").unwrap();
    std::fs::write(path_two.join(".scratch/.scratchmd"), "").unwrap();

    upsert_at(&registry, "wkb_1", &path_one).unwrap();
    upsert_at(&registry, "wkb_1", &path_two).unwrap();

    assert_eq!(
        get_from(&registry, "wkb_1"),
        Some(path_two.canonicalize().unwrap())
    );
}

#[test]
fn get_ignores_missing_or_stale_workspace_paths() {
    let tmp = TempDir::new().unwrap();
    let registry = tmp.path().join("workspaces.yaml");
    let stale_path = tmp.path().join("missing");

    let file = WorkspacesFile {
        version: "1".to_string(),
        workspaces: vec![WorkspaceEntry {
            id: "wkb_1".to_string(),
            path: stale_path.display().to_string(),
        }],
    };
    write_file_at(&registry, &file).unwrap();

    assert_eq!(get_from(&registry, "wkb_1"), None);
}

#[test]
fn remove_deletes_registry_entry_and_returns_path() {
    let tmp = TempDir::new().unwrap();
    let registry = tmp.path().join("workspaces.yaml");
    let path_one = tmp.path().join("one");
    let path_two = tmp.path().join("two");

    let file = WorkspacesFile {
        version: "1".to_string(),
        workspaces: vec![
            WorkspaceEntry {
                id: "wkb_1".to_string(),
                path: path_one.display().to_string(),
            },
            WorkspaceEntry {
                id: "wkb_2".to_string(),
                path: path_two.display().to_string(),
            },
        ],
    };
    write_file_at(&registry, &file).unwrap();

    let removed = remove_at(&registry, "wkb_1").unwrap();

    assert_eq!(removed, Some(path_one));
    assert_eq!(get_from(&registry, "wkb_1"), None);
    assert_eq!(get_from(&registry, "wkb_2"), None);

    let updated = read_file_at(&registry);
    assert_eq!(updated.workspaces.len(), 1);
    assert_eq!(updated.workspaces[0].id, "wkb_2");
}
