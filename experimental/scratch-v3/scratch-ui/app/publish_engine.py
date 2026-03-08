"""Publish engine — build and execute publish plans via the Rust engine.

Port of NestJS publish-plan service (server/src/publish-plan/) adapted for the
standalone scratch-ui. The Rust engine handles plan building (diffing, operation
classification, git I/O); Python handles connectors and DB.

Operation phases execute in order: edit -> create -> delete -> backfill -> rename-files.
Git I/O is handled by Rust via scratch_engine.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict

import scratch_engine

from app import db
from app.config import settings
from app.engine import get_connector, _parse_table_id
from app.routes._helpers import (
    flatten_folders,
    repo_id_for_folder,
)

PHASE_ORDER = ["edit", "create", "delete", "backfill", "rename-files"]
GIT_URL = settings.git_service_url


# ---------------------------------------------------------------------------
# Build plan
# ---------------------------------------------------------------------------


async def build_plan(workbook_id: str) -> dict:
    """Gather git state and call Rust engine to produce a PublishPlan.

    Git I/O (status, file reads, schema reads) is handled entirely in Rust.
    Python only provides folder metadata and file_index from the DB.
    """
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise ValueError("Workbook not found")

    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    file_index = db.get_file_index_all(workbook_id)

    # Group folders by repo ID
    repo_map: dict[str, list[dict]] = defaultdict(list)
    for f in all_folders:
        rid = repo_id_for_folder(f, workbook)
        repo_map[rid].append({"id": f["id"], "path": f.get("path", "")})

    if not repo_map:
        return {"operations": []}

    repo_folders = [{"repoId": rid, "folders": fl} for rid, fl in repo_map.items()]

    plan_json = await asyncio.to_thread(
        scratch_engine.build_plan_from_git,
        GIT_URL,
        json.dumps(repo_folders),
        json.dumps(file_index),
    )
    return json.loads(plan_json)


# ---------------------------------------------------------------------------
# Run plan
# ---------------------------------------------------------------------------


async def run_plan(
    plan: dict,
    workbook_id: str,
) -> dict:
    """Execute a publish plan. Returns summary with counts and errors."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        raise ValueError("Workbook not found")

    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    operations = plan.get("operations", [])

    result = {"edited": 0, "created": 0, "deleted": 0, "backfilled": 0, "renamed": 0, "errors": []}

    # Group operations by phase, then by dataFolderId
    by_phase: dict[str, list[dict]] = defaultdict(list)
    for op in operations:
        by_phase[op.get("phase", "")].append(op)

    for phase in PHASE_ORDER:
        ops = by_phase.get(phase, [])
        if not ops:
            continue

        # Group by dataFolderId
        by_folder: dict[str, list[dict]] = defaultdict(list)
        for op in ops:
            folder_id = op.get("dataFolderId", "")
            by_folder[folder_id].append(op)

        for folder_id, folder_ops in by_folder.items():
            folder = next((f for f in all_folders if f["id"] == folder_id), None)
            if not folder:
                result["errors"].append(f"Folder {folder_id} not found")
                continue

            try:
                if phase == "edit":
                    await _run_edits(folder_ops, folder, workbook, workbook_id, result)
                elif phase == "create":
                    await _run_creates(folder_ops, folder, workbook, workbook_id, result)
                elif phase == "delete":
                    await _run_deletes(folder_ops, folder, workbook, workbook_id, result)
                elif phase == "backfill":
                    await _run_edits(folder_ops, folder, workbook, workbook_id, result, is_backfill=True)
                elif phase == "rename-files":
                    await _run_renames(folder_ops, folder, workbook, workbook_id, result)
            except Exception as e:
                result["errors"].append(f"{phase} error in {folder.get('name', folder_id)}: {e}")

    return result


# ---------------------------------------------------------------------------
# Phase runners
# ---------------------------------------------------------------------------


async def _run_edits(
    ops: list[dict],
    folder: dict,
    workbook: dict,
    workbook_id: str,
    result: dict,
    is_backfill: bool = False,
) -> None:
    """Execute edit or backfill operations: update remote records, then publish files."""
    conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    table_id = _parse_table_id(folder)
    connector = await get_connector(conn_id)
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = folder.get("path", "")

    # For backfill phase, resolve @/path.json pseudo-refs to real record IDs
    file_index = db.get_file_index_all(workbook_id) if is_backfill else {}

    records_to_update: list[dict] = []
    update_paths: list[str] = []
    noop_paths: list[str] = []

    for op in ops:
        path = op.get("path", "")
        remote_id = op.get("remoteRecordId")

        # Resolve remote_record_id from file_index if not on the operation
        if not remote_id:
            filename = path.rsplit("/", 1)[-1] if "/" in path else path
            remote_id = db.get_record_id(workbook_id, folder_path, filename)
        if not remote_id:
            result["errors"].append(f"No remote ID for {path}")
            continue

        # Use changedFields for sparse update if available, otherwise full content
        update_fields = op["changedFields"] if "changedFields" in op else op.get("content", {})
        # Unwrap "fields" envelope — connectors expect flat field data
        if isinstance(update_fields, dict) and "fields" in update_fields and isinstance(update_fields["fields"], dict):
            update_fields = update_fields["fields"]

        # Skip no-op edits (empty changedFields) to avoid wasted API calls
        if isinstance(update_fields, dict) and not update_fields:
            noop_paths.append(path)
            continue

        # Resolve @/path.json pseudo-refs for backfill phase
        if is_backfill and isinstance(update_fields, dict):
            update_fields = _resolve_pseudo_refs(update_fields, file_index)

        records_to_update.append({"id": remote_id, **update_fields})
        update_paths.append(path)

    # Send updates in batches -- only publish files from successful batches
    succeeded_paths: list[str] = []
    batch_size = connector.batch_size("update")
    for i in range(0, len(records_to_update), batch_size):
        chunk = records_to_update[i : i + batch_size]
        chunk_paths = update_paths[i : i + batch_size]
        try:
            await connector.update_records(table_id, chunk)
            succeeded_paths.extend(chunk_paths)
        except Exception as e:
            result["errors"].append(f"update batch: {e}")

    # Publish files from dirty -> main (only successful updates + no-ops)
    paths_to_publish = succeeded_paths + noop_paths
    for path in paths_to_publish:
        try:
            await asyncio.to_thread(
                scratch_engine.git_publish_file, GIT_URL, repo_id, path
            )
        except Exception:
            pass

    count_key = "backfilled" if is_backfill else "edited"
    result[count_key] += len(paths_to_publish)


async def _run_creates(
    ops: list[dict],
    folder: dict,
    workbook: dict,
    workbook_id: str,
    result: dict,
) -> None:
    """Execute create operations: strip temp IDs, create remote records, update file_index."""
    conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    table_id = _parse_table_id(folder)
    connector = await get_connector(conn_id)
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = folder.get("path", "")

    # Determine ID field from schema
    id_field = "id"
    try:
        schema_path = f"{folder_path.lstrip('/')}/.scratch/schema.json"
        data_json = await asyncio.to_thread(
            scratch_engine.git_read_file_content, GIT_URL, repo_id, schema_path, "main"
        )
        data = json.loads(data_json)
        raw = data.get("content", "")
        schema = json.loads(raw) if isinstance(raw, str) else raw
        if schema:
            id_field = schema.get("idColumnRemoteId", "id")
    except Exception:
        pass

    entries: list[tuple[dict, dict]] = []  # (op, content_to_send)
    for op in ops:
        content = dict(op.get("content", {}))
        # Unwrap "fields" envelope — connectors expect flat field data
        if "fields" in content and isinstance(content["fields"], dict):
            content = dict(content["fields"])
        # Strip temp IDs (spub_ prefix)
        current_id = content.get(id_field, "")
        if isinstance(current_id, str) and current_id.startswith("spub_"):
            del content[id_field]
        entries.append((op, content))

    # Create in batches
    batch_size = connector.batch_size("create")
    # Track connector-returned content per path for publishing
    returned_content: dict[str, dict] = {}
    created_paths: set[str] = set()
    for i in range(0, len(entries), batch_size):
        chunk = entries[i : i + batch_size]
        raw_records = [c for _, c in chunk]
        try:
            created = await connector.create_records(table_id, raw_records)
            # Update file_index with real IDs and capture returned content
            index_entries = []
            for j, returned in enumerate(created):
                op = chunk[j][0]
                path = op.get("path", "")
                filename = path.rsplit("/", 1)[-1] if "/" in path else path
                created_paths.add(path)
                raw_id = returned.get(id_field)
                real_id = str(raw_id) if raw_id is not None else ""
                if real_id:
                    index_entries.append({
                        "workbook_id": workbook_id,
                        "folder_path": folder_path,
                        "filename": filename,
                        "record_id": real_id,
                    })
                # Store connector-returned content for git publish
                if isinstance(returned, dict) and returned:
                    returned_content[path] = returned
            if index_entries:
                db.upsert_file_index_batch(index_entries)
            result["created"] += len(created)
        except Exception as e:
            result["errors"].append(f"create batch: {e}")

    # Publish only successfully created files from dirty -> main
    for op, original_content in entries:
        path = op.get("path", "")
        if path not in created_paths:
            continue
        try:
            # Prefer connector-returned content (has real IDs, server-generated fields)
            if path in returned_content:
                content = json.dumps(returned_content[path], indent=2)
                await asyncio.to_thread(
                    scratch_engine.git_publish_content, GIT_URL, repo_id, path, content
                )
            else:
                await asyncio.to_thread(
                    scratch_engine.git_publish_file, GIT_URL, repo_id, path
                )
        except Exception:
            pass


async def _run_deletes(
    ops: list[dict],
    folder: dict,
    workbook: dict,
    workbook_id: str,
    result: dict,
) -> None:
    """Execute delete operations: delete remote records, discard git changes."""
    conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    table_id = _parse_table_id(folder)
    connector = await get_connector(conn_id)
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = folder.get("path", "")

    remote_ids: list[str] = []
    paths: list[str] = []
    for op in ops:
        remote_id = op.get("remoteRecordId")
        if not remote_id:
            filename = op["path"].rsplit("/", 1)[-1] if "/" in op["path"] else op["path"]
            remote_id = db.get_record_id(workbook_id, folder_path, filename)
        if remote_id:
            remote_ids.append(remote_id)
            paths.append(op["path"])

    # Delete in batches -- only clean up successfully deleted records
    deleted_ids: list[str] = []
    deleted_paths: list[str] = []
    batch_size = connector.batch_size("delete")
    for i in range(0, len(remote_ids), batch_size):
        chunk_ids = remote_ids[i : i + batch_size]
        chunk_paths = paths[i : i + batch_size]
        try:
            await connector.delete_records(table_id, chunk_ids)
            result["deleted"] += len(chunk_ids)
            deleted_ids.extend(chunk_ids)
            deleted_paths.extend(chunk_paths)
        except Exception as e:
            result["errors"].append(f"delete batch: {e}")

    # Discard git changes only for successfully deleted records
    for path in deleted_paths:
        try:
            await asyncio.to_thread(
                scratch_engine.git_discard_changes, GIT_URL, repo_id, path
            )
        except Exception:
            pass

    # Clean up file_index only for successfully deleted records
    for rid in deleted_ids:
        try:
            db.delete_file_index(workbook_id, folder_path, rid)
        except Exception:
            pass


async def _run_renames(
    ops: list[dict],
    folder: dict,
    workbook: dict,
    workbook_id: str,
    result: dict,
) -> None:
    """Execute rename-files operations: rename temp-ID files to real-ID filenames."""
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = folder.get("path", "")
    folder_path_stripped = folder_path.lstrip("/")

    renames: list[dict] = []
    index_updates: list[dict] = []

    for op in ops:
        path = op.get("path", "")
        old_name = path.rsplit("/", 1)[-1] if "/" in path else path

        # Look up the real record ID from file_index
        record_id = db.get_record_id(workbook_id, folder_path, old_name)
        if not record_id:
            continue

        new_name = f"{record_id}.json"
        if new_name == old_name:
            continue

        renames.append({"oldName": old_name, "newName": new_name})
        index_updates.append({
            "workbook_id": workbook_id,
            "folder_path": folder_path,
            "filename": new_name,
            "record_id": record_id,
        })

    if renames:
        try:
            await asyncio.to_thread(
                scratch_engine.git_rename_files, GIT_URL, repo_id,
                folder_path_stripped, json.dumps(renames)
            )
            result["renamed"] += len(renames)
        except Exception as e:
            result["errors"].append(f"rename: {e}")
            return

    if index_updates:
        db.upsert_file_index_batch(index_updates)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_pseudo_refs(data: dict, file_index: dict[str, str]) -> dict:
    """Recursively resolve @/path.json pseudo-refs to real record IDs."""
    result = {}
    for key, value in data.items():
        if isinstance(value, str) and value.startswith("@/"):
            # Look up the real record ID from file_index
            ref_path = value[2:]  # strip "@/"
            # Try with and without leading /
            record_id = file_index.get(ref_path) or file_index.get(f"/{ref_path}")
            result[key] = record_id if record_id else value
        elif isinstance(value, list):
            result[key] = [
                (
                    (file_index.get(v[2:]) or file_index.get(f"/{v[2:]}") or v)
                    if isinstance(v, str) and v.startswith("@/")
                    else v
                )
                for v in value
            ]
        elif isinstance(value, dict):
            result[key] = _resolve_pseudo_refs(value, file_index)
        else:
            result[key] = value
    return result
