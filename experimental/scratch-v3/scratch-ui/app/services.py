"""Service layer — business logic shared by HTML routes and JSON API routes.

Git I/O is handled by Rust via scratch_engine. DB lookups stay in Python.
Route handlers call these functions, then decide how to render the result
(HTML template vs JSON response).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import unicodedata
from typing import Any

import scratch_engine

from app import db
from app.config import settings
from app.routes._helpers import (
    all_repo_ids,
    find_folder_for_path,
    flatten_folders,
    normalize,
    repo_id_for_folder,
    set_nested_value,
)

GIT_URL = settings.git_service_url
_MASTER_KEY = os.environ.get("ENCRYPTION_MASTER_KEY", "")


# ── Workbook info ────────────────────────────────────────────────────────────


async def get_workbook_status(workbook_id: str) -> dict:
    """Return workbook metadata, connections, and dirty status."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    folder_groups = db.list_data_folders(workbook_id)
    connections = db.list_connections(workbook_id)
    repo_ids = all_repo_ids(workbook, folder_groups)

    dirty_json = await asyncio.to_thread(
        scratch_engine.git_get_dirty_files, GIT_URL, json.dumps(repo_ids)
    )
    dirty_files = json.loads(dirty_json)

    return {
        "id": workbook["id"],
        "name": workbook.get("name", ""),
        "connections": [
            {"id": c["id"], "name": c.get("display_name", c.get("service", "unnamed"))}
            for c in connections
        ],
        "hasDirty": len(dirty_files) > 0,
        "folderCount": sum(len(g.get("dataFolders", [])) for g in folder_groups),
    }


# ── Changes / diff ──────────────────────────────────────────────────────────


async def get_changes(workbook_id: str) -> list[dict]:
    """Return list of dirty files: [{path, status}]."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    folder_groups = db.list_data_folders(workbook_id)
    repo_ids = all_repo_ids(workbook, folder_groups)

    dirty_json = await asyncio.to_thread(
        scratch_engine.git_get_dirty_files, GIT_URL, json.dumps(repo_ids)
    )
    dirty_files = json.loads(dirty_json)

    return [
        {"path": f.get("path", ""), "status": f.get("status", "modified")}
        for f in dirty_files
    ]


# ── Pull ─────────────────────────────────────────────────────────────────────


async def start_pull(
    workbook_id: str,
    connection_id: str | None = None,
) -> dict:
    """Start a background pull job. Returns {jobId, status}."""
    from app.engine import run_folder_job

    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    all_folders = flatten_folders(db.list_data_folders(workbook_id))

    if connection_id:
        folders = [
            f for f in all_folders
            if (f.get("connectorAccountId") or f.get("connector_account_id", "")) == connection_id
        ]
        if not folders:
            raise LookupError("No folders for this connection")
    else:
        folders = all_folders

    job = db.create_job(workbook_id, "pull", state="active")
    asyncio.create_task(run_folder_job(job["id"], workbook, folders, "pull"))
    return {"jobId": job["id"], "status": "active"}


# ── Push / Publish to external services ──────────────────────────────────────


async def start_push(workbook_id: str) -> dict:
    """Start a background push job (publish engine or fallback). Returns {jobId, status}."""
    from app.engine import run_folder_job

    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    try:
        from app.publish_engine import build_plan, run_plan

        job = db.create_job(workbook_id, "push", state="active")
        asyncio.create_task(_run_publish(job["id"], workbook_id, build_plan, run_plan))
    except ImportError:
        folders = flatten_folders(db.list_data_folders(workbook_id))
        job = db.create_job(workbook_id, "push", state="active")
        asyncio.create_task(run_folder_job(job["id"], workbook, folders, "push"))

    return {"jobId": job["id"], "status": "active"}


async def _run_publish(job_id: str, workbook_id: str, build_plan_fn, run_plan_fn):
    """Background task: build a publish plan and execute it."""
    try:
        plan = await build_plan_fn(workbook_id)
        ops = plan.get("operations", [])
        if not ops:
            db.update_job(job_id, "completed", {
                "publicProgress": {"totalFilesPublished": 0, "folders": []},
            })
            return

        result = await run_plan_fn(plan, workbook_id)
        total = result.get("edited", 0) + result.get("created", 0) + result.get("deleted", 0)
        errors = result.get("errors", [])
        db.update_job(job_id, "failed" if errors else "completed", {
            "publicProgress": {"totalFilesPublished": total},
            "errors": errors,
        })
    except Exception as e:
        db.update_job(job_id, "failed", {"failedReason": str(e), "errors": [str(e)]})


# ── Git-level publish (dirty -> main) ────────────────────────────────────────


async def publish_file(workbook_id: str, path: str) -> None:
    """Publish a single file from dirty branch to main."""
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(path, folders)
    if not folder or not workbook:
        raise LookupError("Folder not found for path")
    rid = repo_id_for_folder(folder, workbook)
    await asyncio.to_thread(scratch_engine.git_publish_file, GIT_URL, rid, path)


async def publish_all_files(workbook_id: str) -> dict:
    """Publish all dirty files from dirty -> main. Returns {published, errors}."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    folder_groups = db.list_data_folders(workbook_id)
    repo_ids = all_repo_ids(workbook, folder_groups)

    dirty_json = await asyncio.to_thread(
        scratch_engine.git_get_dirty_files, GIT_URL, json.dumps(repo_ids)
    )
    dirty_files = json.loads(dirty_json)

    file_specs = []
    for f in dirty_files:
        p = normalize(f.get("path", ""))
        folder = find_folder_for_path(p, folder_groups)
        if not folder:
            continue
        rid = repo_id_for_folder(folder, workbook)
        file_specs.append({"repoId": rid, "path": p})

    result_json = await asyncio.to_thread(
        scratch_engine.git_publish_all, GIT_URL, json.dumps(file_specs)
    )
    return json.loads(result_json)


# ── Discard ──────────────────────────────────────────────────────────────────


async def discard_changes(workbook_id: str, path: str) -> None:
    """Discard changes to a single file."""
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(path, folders)
    if not folder or not workbook:
        raise LookupError("Folder not found for path")
    rid = repo_id_for_folder(folder, workbook)
    await asyncio.to_thread(scratch_engine.git_discard_changes, GIT_URL, rid, path)


# ── File read/write ──────────────────────────────────────────────────────────


async def read_file(workbook_id: str, path: str) -> dict:
    """Read a file's content. Returns {path, content, fields}."""
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(path, folders)
    if not folder or not workbook:
        return {"path": path, "content": "", "fields": {}}
    rid = repo_id_for_folder(folder, workbook)

    result_json = await asyncio.to_thread(scratch_engine.git_read_file, GIT_URL, rid, path)
    file_data = json.loads(result_json)

    content = file_data.get("content", "")
    parsed = {}
    if isinstance(content, str) and content:
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            pass
    elif isinstance(content, dict):
        parsed = content

    return {"path": path, "content": content, "fields": parsed}


async def write_file_content(workbook_id: str, path: str, content: str) -> None:
    """Write raw content to a file."""
    full_path = normalize(path)
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(full_path, folders)
    if not folder or not workbook:
        raise LookupError("Folder not found for path")
    rid = repo_id_for_folder(folder, workbook)
    files = [{"path": full_path.lstrip("/"), "content": content}]
    await asyncio.to_thread(
        scratch_engine.git_write_files, GIT_URL, rid, json.dumps(files), "dirty"
    )


async def write_file_field(
    workbook_id: str, path: str, field_path: str, value: Any
) -> dict:
    """Update a single field in a JSON file. Returns the updated content."""
    full_path = normalize(path)
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(full_path, folders)
    if not folder or not workbook:
        raise LookupError("Folder not found for path")
    rid = repo_id_for_folder(folder, workbook)

    result_json = await asyncio.to_thread(scratch_engine.git_read_file, GIT_URL, rid, full_path)
    file_data = json.loads(result_json)
    raw_content = file_data.get("content", "")

    content = {}
    if isinstance(raw_content, str) and raw_content:
        try:
            content = json.loads(raw_content)
        except (json.JSONDecodeError, TypeError):
            pass
    elif isinstance(raw_content, dict):
        content = raw_content

    if isinstance(content, dict) and "fields" in content and isinstance(content["fields"], dict):
        set_nested_value(content["fields"], field_path, value)
    else:
        set_nested_value(content, field_path, value)

    files = [{"path": full_path.lstrip("/"), "content": json.dumps(content, indent=2)}]
    await asyncio.to_thread(
        scratch_engine.git_write_files, GIT_URL, rid, json.dumps(files), "dirty"
    )
    return content


# ── Download / Push (CLI file transfer) ──────────────────────────────────


async def download_all_files(workbook_id: str, branch: str = "dirty") -> list[dict]:
    """Download all files across all folders. Returns [{path, content}].

    ``branch`` selects which git branch to read from (``"dirty"`` or ``"main"``).
    """
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    all_folders = flatten_folders(db.list_data_folders(workbook_id))
    if not all_folders:
        return []

    folder_specs = []
    for folder in all_folders:
        rid = repo_id_for_folder(folder, workbook)
        folder_path = folder.get("path") or ""
        folder_specs.append({"repoId": rid, "folderPath": folder_path})

    result_json = await asyncio.to_thread(
        scratch_engine.git_download_all_files, GIT_URL, json.dumps(folder_specs), branch
    )
    return json.loads(result_json)


async def push_files(workbook_id: str, files: list[dict]) -> dict:
    """Push local files to server git (dirty branch). Returns {written, errors}."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    all_folders = flatten_folders(db.list_data_folders(workbook_id))
    if not all_folders:
        raise LookupError("No folders configured")

    by_repo: dict[str, list[dict]] = {}
    for f in files:
        p = normalize(f.get("path", ""))
        folder = find_folder_for_path(p, db.list_data_folders(workbook_id))
        if not folder:
            continue
        rid = repo_id_for_folder(folder, workbook)
        by_repo.setdefault(rid, []).append({
            "path": p.lstrip("/"),
            "content": f.get("content", ""),
        })

    repo_writes = [{"repoId": rid, "files": ops} for rid, ops in by_repo.items()]
    result_json = await asyncio.to_thread(
        scratch_engine.git_push_files, GIT_URL, json.dumps(repo_writes)
    )
    return json.loads(result_json)


# ── Sync ─────────────────────────────────────────────────────────────────────


async def execute_sync(sync_id: str, workbook_id: str) -> dict:
    """Run a sync mapping. Returns {created, updated, errors, warnings}."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise LookupError("Workbook not found")

    from app.sync_engine import run_sync

    result = await run_sync(sync_id, workbook_id)
    return {
        "created": result.created,
        "updated": result.updated,
        "errors": [{"sourceId": e.source_id, "error": e.error} for e in result.errors] if result.errors else [],
        "warnings": [{"sourceId": w.source_id, "warning": w.warning} for w in result.warnings] if result.warnings else [],
    }


# ── Connections ──────────────────────────────────────────────────────────────


async def test_connection(conn_id: str) -> None:
    """Test a connection's credentials. Raises on failure."""
    from app.engine import get_connector

    connector = await get_connector(conn_id)
    await connector.test_connection()


async def create_connection(
    workspace_id: str, service: str, credentials: dict, display_name: str | None = None,
) -> dict:
    """Test credentials, encrypt, and save a new connection. Raises on test failure."""
    from app.connectors import connectors

    workbook = db.get_workbook(workspace_id)
    if not workbook:
        raise LookupError("Workspace not found")

    cls = connectors.get(service.lower())
    if not cls:
        raise ValueError(f"Unknown service: {service}")

    # Test BEFORE saving — no orphan records on failure
    connector = cls(credentials)
    await connector.test_connection()

    encrypted_json = encrypt_credentials(credentials)
    conn_row = db.create_connection(workspace_id, {
        "service": service.upper(),
        "authType": cls.auth_type,
        "displayName": display_name or cls.display_name,
        "encryptedCredentials": encrypted_json,
    })
    return conn_row


async def delete_connection(workspace_id: str, conn_id: str) -> None:
    """Delete a connection and its linked folders."""
    conn_row = db.get_connection(conn_id)
    if not conn_row:
        raise LookupError("Connection not found")
    db.delete_connection(conn_id)


async def discover_tables(conn_id: str) -> list[dict]:
    """Discover remote tables for a connection. Returns [{remoteId, name}]."""
    from app.engine import get_connector

    connector = await get_connector(conn_id)
    tables = await connector.list_tables()
    return [{"remoteId": t.remote_id, "name": t.name} for t in tables]


# ── Workspaces ──────────────────────────────────────────────────────────────


async def create_workspace(name: str, user_id: str = "local") -> dict:
    """Create a new workspace."""
    return db.create_workspace(name, user_id=user_id)


async def list_workspaces(user_id: str | None = None) -> list[dict]:
    """List workspaces, optionally filtered by user."""
    return db.list_workbooks(user_id=user_id)


async def delete_workspace(workspace_id: str) -> None:
    """Delete a workspace and all related data."""
    workbook = db.get_workbook(workspace_id)
    if not workbook:
        raise LookupError("Workspace not found")
    db.delete_workspace(workspace_id)


# ── Folders (link/unlink tables) ────────────────────────────────────────────


async def link_tables(
    workspace_id: str, conn_id: str, tables: list[dict],
) -> list[dict]:
    """Link remote tables as data folders. Each table: {remoteId, name}.

    Creates folders, inits git repo, and starts a background pull.
    Returns the created folder records.
    """
    from app.engine import run_folder_job

    workbook = db.get_workbook(workspace_id)
    if not workbook:
        raise LookupError("Workspace not found")

    conn_row = db.get_connection(conn_id)
    if not conn_row:
        raise LookupError("Connection not found")

    service = conn_row["service"]
    display_name = conn_row.get("displayName") or conn_row.get("display_name", service)

    folders_created: list[dict] = []
    folders_to_pull: list[dict] = []

    for table in tables:
        table_id = table["remoteId"]
        if isinstance(table_id, str):
            try:
                table_id = json.loads(table_id)
            except (json.JSONDecodeError, TypeError):
                table_id = [table_id]
        table_name = table.get("name", "")

        parts = [p.strip() for p in table_name.split(" / ")]
        folder_name = slugify(parts[-1])
        path_segments = [slugify(display_name)] + [slugify(p) for p in parts]
        folder_path = "/" + "/".join(path_segments)

        folder = db.create_data_folder({
            "workbookId": workspace_id,
            "connectorAccountId": conn_id,
            "connectorService": service,
            "connectorDisplayName": display_name,
            "name": folder_name,
            "path": folder_path,
            "tableId": table_id,
        })
        if folder:
            folder["connectorAccountId"] = conn_id
            folder["tableId"] = table_id
            folders_created.append(folder)
            folders_to_pull.append(folder)

    # Ensure git repo exists, then kick off initial pull in background
    if folders_to_pull:
        repo_id = f"{workbook['organization_id']}--{workspace_id}--{conn_id}"
        try:
            await asyncio.to_thread(scratch_engine.git_init_repo, GIT_URL, repo_id)
        except Exception:
            pass  # repo may already exist
        job = db.create_job(workspace_id, "pull", state="active")
        asyncio.create_task(run_folder_job(job["id"], workbook, folders_to_pull, "pull"))

    return folders_created


async def unlink_folder(workspace_id: str, folder_id: str) -> None:
    """Unlink (delete) a data folder."""
    folder = db.get_data_folder(folder_id)
    if not folder:
        raise LookupError("Folder not found")
    db.delete_data_folder(folder_id)


# ── Syncs (CRUD) ────────────────────────────────────────────────────────────


async def create_sync(workspace_id: str, payload: dict) -> dict:
    """Create a new sync."""
    workbook = db.get_workbook(workspace_id)
    if not workbook:
        raise LookupError("Workspace not found")
    return db.create_sync(workspace_id, payload)


async def get_sync(workspace_id: str, sync_id: str) -> dict:
    """Get a sync by ID."""
    sync = db.get_sync(workspace_id, sync_id)
    if not sync:
        raise LookupError("Sync not found")
    return sync


async def update_sync(workspace_id: str, sync_id: str, payload: dict) -> dict:
    """Update a sync."""
    existing = db.get_sync(workspace_id, sync_id)
    if not existing:
        raise LookupError("Sync not found")
    return db.update_sync(workspace_id, sync_id, payload)


async def delete_sync(workspace_id: str, sync_id: str) -> None:
    """Delete a sync."""
    existing = db.get_sync(workspace_id, sync_id)
    if not existing:
        raise LookupError("Sync not found")
    db.delete_sync(workspace_id, sync_id)


# ── Shared helpers ──────────────────────────────────────────────────────────


def encrypt_credentials(creds: dict) -> str:
    """Encrypt credentials using the master key, or return as plain JSON."""
    if not creds:
        return "{}"
    if _MASTER_KEY and len(_MASTER_KEY) >= 32:
        from app.crypto import encrypt_obj
        return json.dumps(encrypt_obj(creds, _MASTER_KEY))
    return json.dumps(creds)


def slugify(name: str) -> str:
    """Convert a name to a URL-safe slug."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^\w\s-]", "", s).strip().lower()
    return re.sub(r"[-\s]+", "-", s) or "folder"


# ── Jobs ─────────────────────────────────────────────────────────────────────


def get_job_status(job_id: str) -> dict:
    """Get job status with parsed result data."""
    job = db.get_job(job_id)
    if not job:
        raise LookupError("Job not found")

    result_data = {}
    if isinstance(job.get("result"), str):
        try:
            result_data = json.loads(job["result"])
        except (json.JSONDecodeError, TypeError):
            pass
    elif isinstance(job.get("result"), dict):
        result_data = job["result"]

    return {
        "jobId": job["id"],
        "status": job.get("state", "unknown"),
        "type": job.get("type", ""),
        "createdAt": job.get("created_at", ""),
        "completedAt": job.get("completed_at"),
        **result_data,
    }
