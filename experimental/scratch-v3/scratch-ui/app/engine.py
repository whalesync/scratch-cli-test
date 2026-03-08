"""Connector factory, pull engine, push engine.

Three functions that wire connectors to git storage:

  get_connector(conn_id) -> live Connector instance
  pull_folder(workbook, folder) -> external service -> git dirty branch
  push_folder(workbook, folder) -> git dirty diff -> external service -> git publish

Git I/O is handled by Rust via scratch_engine.
"""

from __future__ import annotations

import asyncio
import json
import os

import scratch_engine

from app import db
from app.config import settings
from app.connectors import connectors
from app.connectors.base import Connector
from app.routes._helpers import repo_id_for_folder

_MASTER_KEY = os.environ.get("ENCRYPTION_MASTER_KEY", "")
GIT_URL = settings.git_service_url


# ---------------------------------------------------------------------------
# Connector factory
# ---------------------------------------------------------------------------


async def get_connector(connector_account_id: str) -> Connector:
    """Instantiate a live Connector from a stored connector_account row."""
    account = db.get_connection(connector_account_id)
    if not account:
        raise ValueError(f"Connector account {connector_account_id} not found")

    service = account["service"].lower()
    cls = connectors.get(service)
    if not cls:
        raise ValueError(f"No connector registered for service: {service}")

    if account.get("auth_type") == "OAUTH":
        from app.routes.oauth import get_valid_access_token
        token = await get_valid_access_token(connector_account_id)
        creds = {"apiKey": token}
    else:
        creds = load_credentials(account)

    return cls(creds)


def load_credentials(account: dict) -> dict:
    raw = account.get("encrypted_credentials", "{}")
    if not raw or raw == "{}":
        return {}
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return {}
    if data.get("iv") and data.get("salt") and _MASTER_KEY:
        from app.crypto import decrypt_obj
        return decrypt_obj(data, _MASTER_KEY)
    return data


# ---------------------------------------------------------------------------
# Pull engine
# ---------------------------------------------------------------------------


async def pull_folder(
    workbook: dict,
    folder: dict,
) -> dict:
    """Pull records from external service -> write as JSON files to git.

    Returns {created: int, updated: int, errors: list[str]}.
    """
    conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    table_id = _parse_table_id(folder)
    connector = await get_connector(conn_id)
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = (folder.get("path") or "").lstrip("/")

    # Existing files on main branch -> detect creates vs updates
    existing: set[str] = set()
    try:
        files_json = await asyncio.to_thread(
            scratch_engine.git_list_files, GIT_URL, repo_id, folder_path, "main"
        )
        files = json.loads(files_json)
        for f in files:
            name = f.get("name", "")
            if name.endswith(".json"):
                existing.add(name[:-5])
    except Exception:
        pass  # repo may not exist yet

    created = 0
    updated = 0
    errors: list[str] = []
    batch: list[dict] = []
    schema_sample: list[dict] = []
    index_entries: list[dict] = []
    workbook_id = workbook.get("id", "")

    async for records in connector.pull_records(table_id):
        for record in records:
            remote_id = str(record.get("id", ""))
            if not remote_id:
                continue
            filename = _safe_filename(remote_id)
            path = f"{folder_path}/{filename}.json" if folder_path else f"{filename}.json"
            batch.append({"path": path, "content": json.dumps(record, default=str, ensure_ascii=False)})
            index_entries.append({
                "workbook_id": workbook_id,
                "folder_path": "/" + folder_path if folder_path else "/",
                "filename": f"{filename}.json",
                "record_id": remote_id,
            })
            if filename in existing:
                updated += 1
            else:
                created += 1
            if len(schema_sample) < 10:
                schema_sample.append(record)

        if len(batch) >= 200:
            try:
                await asyncio.to_thread(
                    scratch_engine.git_write_files, GIT_URL, repo_id,
                    json.dumps(batch), "main"
                )
            except Exception as e:
                errors.append(str(e))
            batch = []

    # Write schema from metadata API (preferred) or inferred from records (fallback)
    schema = None
    try:
        schema = await connector.fetch_schema(table_id)
    except Exception:
        pass
    if not schema and schema_sample:
        schema = _infer_schema(schema_sample, folder.get("name", ""))
    if schema:
        schema_path = f"{folder_path}/.scratch/schema.json" if folder_path else ".scratch/schema.json"
        batch.append({"path": schema_path, "content": json.dumps(schema, indent=2)})

    if batch:
        try:
            await asyncio.to_thread(
                scratch_engine.git_write_files, GIT_URL, repo_id,
                json.dumps(batch), "main"
            )
        except Exception as e:
            errors.append(str(e))

    # Populate file_index for publish lookups
    if index_entries and not errors:
        try:
            db.upsert_file_index_batch(index_entries)
        except Exception:
            pass  # Non-critical

    # Rebase dirty onto main so pulled data is the clean baseline
    if not errors:
        try:
            await asyncio.to_thread(scratch_engine.git_rebase_dirty, GIT_URL, repo_id)
        except Exception as e:
            errors.append(f"rebase: {e}")

    if not errors:
        db.update_folder_sync_time(folder["id"])

    return {"created": created, "updated": updated, "errors": errors}


# ---------------------------------------------------------------------------
# Push engine
# ---------------------------------------------------------------------------


async def push_folder(
    workbook: dict,
    folder: dict,
) -> dict:
    """Push git dirty changes to external service, then publish in git.

    Returns {created: int, updated: int, deleted: int, errors: list[str]}.
    """
    conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    table_id = _parse_table_id(folder)
    connector = await get_connector(conn_id)
    repo_id = repo_id_for_folder(folder, workbook)
    folder_path = (folder.get("path") or "").rstrip("/")

    status_json = await asyncio.to_thread(scratch_engine.git_status, GIT_URL, repo_id)
    status_files = json.loads(status_json)
    if isinstance(status_files, dict):
        status_files = status_files.get("data", []) if "data" in status_files else []
    relevant = _files_in_folder(status_files, folder_path)
    if not relevant:
        return {"created": 0, "updated": 0, "deleted": 0, "errors": []}

    to_create, to_update, to_delete, file_map = await _categorize(repo_id, relevant)
    result = {"created": 0, "updated": 0, "deleted": 0, "errors": []}

    # Creates
    for chunk in _chunks(to_create, connector.batch_size("create")):
        try:
            created = await connector.create_records(table_id, chunk)
            result["created"] += len(created)
        except Exception as e:
            result["errors"].append(f"create: {e}")

    # Updates
    for chunk in _chunks(to_update, connector.batch_size("update")):
        try:
            await connector.update_records(table_id, chunk)
            result["updated"] += len(chunk)
        except Exception as e:
            result["errors"].append(f"update: {e}")

    # Deletes
    for chunk in _chunks(to_delete, connector.batch_size("delete")):
        try:
            await connector.delete_records(table_id, chunk)
            result["deleted"] += len(chunk)
        except Exception as e:
            result["errors"].append(f"delete: {e}")

    # On success, publish all files from dirty -> main
    if not result["errors"]:
        for f in relevant:
            path = f["path"]
            try:
                if f.get("status") == "deleted":
                    await asyncio.to_thread(
                        scratch_engine.git_discard_changes, GIT_URL, repo_id, path
                    )
                else:
                    data_json = await asyncio.to_thread(
                        scratch_engine.git_read_file_content, GIT_URL, repo_id,
                        path.lstrip("/"), "dirty"
                    )
                    data = json.loads(data_json)
                    content = data.get("content", "")
                    await asyncio.to_thread(
                        scratch_engine.git_publish_content, GIT_URL, repo_id, path, content
                    )
            except Exception:
                pass

    return result


# ---------------------------------------------------------------------------
# Shared background job runner
# ---------------------------------------------------------------------------


async def run_folder_job(
    job_id: str,
    workbook: dict,
    folders: list[dict],
    operation: str = "pull",
) -> None:
    """Run pull or push across folders with progress tracking and cooperative cancellation.

    operation: "pull" or "push"
    """
    fn = pull_folder if operation == "pull" else push_folder
    try:
        folder_results: list[dict] = []
        errors: list[str] = []

        for folder in folders:
            # Cooperative cancellation: check if job was canceled
            job = db.get_job(job_id)
            if job and job.get("state") == "canceled":
                break

            conn_id = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
            if not conn_id or not folder.get("tableId"):
                continue
            try:
                result = await fn(workbook, folder)
                entry = {
                    "name": folder.get("name", "?"),
                    "creates": result.get("created", 0),
                    "updates": result.get("updated", 0),
                    "status": "failed" if result.get("errors") else "completed",
                    "errors": [{"error": e} for e in result.get("errors", [])],
                }
                if operation == "push":
                    entry["deletes"] = result.get("deleted", 0)
                folder_results.append(entry)
                errors.extend(result.get("errors", []))
            except Exception as e:
                folder_results.append({
                    "name": folder.get("name", "?"),
                    "status": "failed",
                    "errors": [{"error": str(e)}],
                })
                errors.append(str(e))

        # Check final state
        job = db.get_job(job_id)
        if job and job.get("state") == "canceled":
            return  # already marked canceled, don't overwrite

        total = sum(
            f.get("creates", 0) + f.get("updates", 0) + f.get("deletes", 0)
            for f in folder_results
        )
        progress_key = "totalFilesPublished" if operation == "push" else "totalFilesSynced"
        db.update_job(job_id, "failed" if errors else "completed", {
            "publicProgress": {progress_key: total, "folders": folder_results},
            "errors": errors,
        })
    except Exception as e:
        db.update_job(job_id, "failed", {"failedReason": str(e), "errors": [str(e)]})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_table_id(folder: dict) -> list[str]:
    tid = folder.get("tableId") or folder.get("table_id") or []
    if isinstance(tid, str):
        try:
            tid = json.loads(tid)
        except (json.JSONDecodeError, TypeError):
            tid = []
    return tid


def _safe_filename(remote_id: str) -> str:
    return remote_id.replace("/", "_").replace("\\", "_").replace("\0", "")


def _id_from_path(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name[:-5] if name.endswith(".json") else name


def _files_in_folder(status_files: list[dict], folder_path: str) -> list[dict]:
    result = []
    prefix = f"/{folder_path.strip('/')}/" if folder_path else "/"
    for f in status_files:
        p = f.get("path", "")
        if not p.startswith("/"):
            p = f"/{p}"
        if p.startswith(prefix) or (not folder_path and "/" not in p.lstrip("/")):
            result.append({**f, "path": p})
    return result


async def _categorize(
    repo_id: str, files: list[dict]
) -> tuple[list[dict], list[dict], list[str], dict]:
    to_create: list[dict] = []
    to_update: list[dict] = []
    to_delete: list[str] = []
    file_map: dict[str, dict] = {}

    for f in files:
        status = f.get("status", "modified")
        path = f["path"]

        if status == "deleted":
            remote_id = _id_from_path(path)
            if remote_id:
                to_delete.append(remote_id)
            continue

        try:
            data_json = await asyncio.to_thread(
                scratch_engine.git_read_file_content, GIT_URL, repo_id,
                path.lstrip("/"), "dirty"
            )
            data = json.loads(data_json)
            content = data.get("content", "")
            record = json.loads(content) if isinstance(content, str) else content
        except Exception:
            continue

        file_map[path] = record
        if status == "added":
            to_create.append(record)
        else:
            to_update.append(record)

    return to_create, to_update, to_delete, file_map


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ---------------------------------------------------------------------------
# Schema inference
# ---------------------------------------------------------------------------


def _infer_schema(records: list[dict], name: str = "") -> dict:
    """Infer a basic schema from pulled records. Written to .scratch/schema.json."""
    columns: dict[str, str] = {}
    for record in records[:10]:
        for k, v in record.items():
            if k not in columns and not k.startswith("_"):
                columns[k] = _js_type(v)
            # Flatten Airtable-style "fields" wrapper
            if k == "fields" and isinstance(v, dict):
                for fk, fv in v.items():
                    key = f"fields.{fk}"
                    if key not in columns:
                        columns[key] = _js_type(fv)

    return {
        "name": name,
        "idColumnRemoteId": "id",
        "columns": [{"name": k, "type": v} for k, v in columns.items()],
    }


def _js_type(value) -> str:
    if value is None:
        return "string"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "string"
