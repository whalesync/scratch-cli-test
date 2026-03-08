#!/usr/bin/env python3
"""Set up a Scratch workspace for end-to-end scenario testing via the CLI.

Uses `scratch` CLI commands to create a workspace, add connections,
link tables, and configure syncs — the same way a real user would.

Usage:
    python3 setup.py

Requires .env with AIRTABLE_TOKEN, AIRTABLE_BASE_ID, WP_URL, WP_USER,
WP_APP_PASSWORD, and all table IDs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent


def _ensure_scratch_on_path():
    """Add the scratch CLI binary to PATH if not already available."""
    import shutil
    if shutil.which("scratch"):
        return
    for profile in ("debug", "release"):
        candidate = REPO_ROOT / "scratch-engine" / "target" / profile / "scratch"
        if candidate.is_file():
            os.environ["PATH"] = str(candidate.parent) + os.pathsep + os.environ.get("PATH", "")
            return
    print("Error: scratch CLI not found. Build it first:", file=sys.stderr)
    print(f"  cd {REPO_ROOT}/scratch-engine && cargo build -p scratch-cli", file=sys.stderr)
    sys.exit(1)


def run(cmd: str) -> str:
    """Run a shell command, print it, return stdout."""
    print(f"  $ {cmd}")
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True,
        env={**os.environ, "NO_COLOR": "1"},  # disable ANSI colors for parsing
    )
    if result.returncode != 0:
        print(f"    FAILED: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    if result.stdout.strip():
        print(f"    {result.stdout.strip()}")
    return result.stdout.strip()


def extract_id(output: str) -> str:
    """Extract an ID from CLI output like '  ID:   ws_abc123'."""
    match = re.search(r"ID:\s+(\S+)", output)
    if not match:
        print(f"    Could not parse ID from output: {output!r}", file=sys.stderr)
        sys.exit(1)
    return match.group(1)


def write_sync_config(filename: str, config: dict) -> str:
    """Write a sync config JSON file and return its path."""
    syncs_dir = SCRIPT_DIR / "syncs"
    syncs_dir.mkdir(exist_ok=True)
    path = syncs_dir / filename
    path.write_text(json.dumps(config, indent=2) + "\n")
    return str(path)


def main():
    _ensure_scratch_on_path()
    print("Phase 0: Setting up workspace via CLI\n")

    # 1. Create workspace
    print("1. Creating workspace...")
    ws_output = run('scratch workspace create --name "Scenario Test"')
    ws_id = extract_id(ws_output)
    print(f"    Workspace ID: {ws_id}")

    # 2. Init local workspace (creates .scratch/config.json)
    print("\n2. Initializing local workspace...")
    run(f"scratch init {ws_id}")

    # 3. Add connections
    print("\n3. Adding connections...")
    at_output = run('scratch connection add --service AIRTABLE --param apiKey="$AIRTABLE_TOKEN"')
    at_conn_id = extract_id(at_output)
    print(f"    Airtable connection ID: {at_conn_id}")

    wp_output = run(
        'scratch connection add --service WORDPRESS'
        ' --param endpoint="$WP_URL"'
        ' --param username="$WP_USER"'
        ' --param password="$WP_APP_PASSWORD"'
    )
    wp_conn_id = extract_id(wp_output)
    print(f"    WordPress connection ID: {wp_conn_id}")

    # 4. Link Airtable tables
    print("\n4. Linking Airtable tables...")
    run(f"scratch table add {at_conn_id} --table Tags")
    run(f"scratch table add {at_conn_id} --table Authors")
    run(f"scratch table add {at_conn_id} --table Posts")
    run(f"scratch table add {at_conn_id} --table Pages")
    run(f"scratch table add {at_conn_id} --table Products")

    # 5. Link WordPress tables
    print("\n5. Linking WordPress tables...")
    run(f"scratch table add {wp_conn_id} --table Posts")
    run(f"scratch table add {wp_conn_id} --table Pages")
    run(f"scratch table add {wp_conn_id} --table Categories")

    # 6. Get folder IDs for sync config
    print("\n6. Looking up folder IDs...")
    table_output = run("scratch table list")
    folders = _parse_folder_table(table_output)

    at_tags_id = _find_folder(folders, "tags", "AIRTABLE")
    at_authors_id = _find_folder(folders, "authors", "AIRTABLE")
    at_posts_id = _find_folder(folders, "posts", "AIRTABLE")
    at_pages_id = _find_folder(folders, "pages", "AIRTABLE")
    wp_categories_id = _find_folder(folders, "categories", "WORDPRESS")
    wp_posts_id = _find_folder(folders, "posts", "WORDPRESS")
    wp_pages_id = _find_folder(folders, "pages", "WORDPRESS")

    # 7. Create sync configs
    print("\n7. Creating syncs...")

    tags_config = write_sync_config("tags-categories.json", {
        "displayName": "Tags → Categories",
        "mappings": {
            "version": 1,
            "tableMappings": [{
                "sourceDataFolderId": at_tags_id,
                "destinationDataFolderId": wp_categories_id,
                "columnMappings": [
                    {"sourceColumnId": "fields.Name", "destinationColumnId": "fields.name"},
                    {"sourceColumnId": "fields.Name", "destinationColumnId": "fields.slug",
                     "transformer": {"type": "slugify", "options": {"separator": "-"}}},
                    # auto_convert: ensure WP description is a string even if source is null
                    {"sourceColumnId": "fields.Name", "destinationColumnId": "fields.description",
                     "transformer": {"type": "auto_convert", "options": {"targetType": "string"}}},
                ],
                "recordMatching": {
                    "sourceColumnId": "fields.Name",
                    "destinationColumnId": "fields.name",
                },
            }],
        },
    })
    run(f'scratch sync create --name "Tags → Categories" --config {tags_config}')

    posts_config = write_sync_config("posts-wp-posts.json", {
        "displayName": "Posts → WordPress Posts",
        "mappings": {
            "version": 1,
            "tableMappings": [{
                "sourceDataFolderId": at_posts_id,
                "destinationDataFolderId": wp_posts_id,
                "columnMappings": [
                    {"sourceColumnId": "fields.Title", "destinationColumnId": "fields.title"},
                    {"sourceColumnId": "fields.Body", "destinationColumnId": "fields.content"},
                    {"sourceColumnId": "fields.Title", "destinationColumnId": "fields.slug",
                     "transformer": {"type": "slugify"}},
                    {"sourceColumnId": "fields.SEO Description", "destinationColumnId": "fields.excerpt"},
                    # lookup_field: resolve Author FK to author name
                    {"sourceColumnId": "fields.Author", "destinationColumnId": "fields.author_name",
                     "transformer": {"type": "lookup_field", "options": {
                         "referencedDataFolderId": at_authors_id,
                         "fieldPath": "fields.Name",
                     }}},
                ],
                "recordMatching": {
                    "sourceColumnId": "fields.Title",
                    "destinationColumnId": "fields.title",
                },
            }],
        },
    })
    run(f'scratch sync create --name "Posts → WordPress Posts" --config {posts_config}')

    pages_config = write_sync_config("pages-wp-pages.json", {
        "displayName": "Pages → WordPress Pages",
        "mappings": {
            "version": 1,
            "tableMappings": [{
                "sourceDataFolderId": at_pages_id,
                "destinationDataFolderId": wp_pages_id,
                "columnMappings": [
                    {"sourceColumnId": "fields.Title", "destinationColumnId": "fields.title"},
                    {"sourceColumnId": "fields.Body", "destinationColumnId": "fields.content"},
                    {"sourceColumnId": "fields.Title", "destinationColumnId": "fields.slug",
                     "transformer": {"type": "slugify"}},
                ],
                "recordMatching": {
                    "sourceColumnId": "fields.Title",
                    "destinationColumnId": "fields.title",
                },
            }],
        },
    })
    run(f'scratch sync create --name "Pages → WordPress Pages" --config {pages_config}')

    # 8. Create validation schemas for WordPress folders
    print("\n8. Creating validation schemas...")
    schemas_dir = Path(".scratch/schemas/wordpress")
    schemas_dir.mkdir(parents=True, exist_ok=True)

    # Posts schema — validates synced post structure
    (schemas_dir / "posts.json").write_text(json.dumps({
        "type": "object",
        "required": ["fields"],
        "properties": {
            "id": {"type": "string"},
            "fields": {
                "type": "object",
                "required": ["title", "slug"],
                "properties": {
                    "title": {"type": "string", "minLength": 1},
                    "slug": {"type": "string", "pattern": "^[a-z0-9-]+$"},
                    "content": {"type": "string"},
                    "excerpt": {"type": "string"},
                    "status": {"type": "string", "readOnly": True},
                    # lookup_field returns an array for array FK fields
                    "author_name": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
            },
        },
    }, indent=2) + "\n")
    print("  Created .scratch/schemas/wordpress/posts.json")

    # Pages schema
    (schemas_dir / "pages.json").write_text(json.dumps({
        "type": "object",
        "required": ["fields"],
        "properties": {
            "id": {"type": "string"},
            "fields": {
                "type": "object",
                "required": ["title", "slug"],
                "properties": {
                    "title": {"type": "string", "minLength": 1},
                    "slug": {"type": "string", "pattern": "^[a-z0-9-]+$"},
                    "content": {"type": "string"},
                    "status": {"type": "string", "readOnly": True},
                },
            },
        },
    }, indent=2) + "\n")
    print("  Created .scratch/schemas/wordpress/pages.json")

    # Categories schema — must handle both synced records (have "fields"
    # wrapper) and pulled WordPress records (flat structure, numeric id)
    (schemas_dir / "categories.json").write_text(json.dumps({
        "type": "object",
        "properties": {
            "id": {},
            "fields": {
                "type": "object",
                "required": ["name", "slug"],
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "slug": {"type": "string", "pattern": "^[a-z0-9-]+$"},
                    "description": {"type": "string"},
                },
            },
        },
    }, indent=2) + "\n")
    print("  Created .scratch/schemas/wordpress/categories.json")

    # 9. Create validator config (.scratch/validators.json)
    print("\n9. Creating validator config...")
    validators_config = {
        "wordpress/posts": {
            "readonly_fields": ["status"],
        },
    }
    validators_path = Path(".scratch/validators.json")
    validators_path.write_text(json.dumps(validators_config, indent=2) + "\n")
    print("  Created .scratch/validators.json")

    # 10. Pull from all connections
    print("\n10. Pulling from all connections...")
    run("scratch pull")

    print("\nSetup complete.")


def _parse_folder_table(output: str) -> list[dict]:
    """Parse the tabular output from `scratch table list` into dicts."""
    lines = output.strip().splitlines()
    if len(lines) < 2:
        return []
    folders = []
    for line in lines[1:]:  # skip header
        parts = line.split()
        if len(parts) >= 3:
            folders.append({
                "id": parts[0],
                "path": parts[1],
                "service": parts[2],
            })
    return folders


def _find_folder(folders: list[dict], name: str, service: str) -> str:
    """Find a folder by name (last path segment) and service."""
    for f in folders:
        path = f["path"]
        last_segment = path.rstrip("/").rsplit("/", 1)[-1]
        if last_segment == name and f["service"].upper() == service.upper():
            return f["id"]
    print(f"    ERROR: Could not find folder '{name}' for service '{service}'", file=sys.stderr)
    print(f"    Available folders: {folders}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
