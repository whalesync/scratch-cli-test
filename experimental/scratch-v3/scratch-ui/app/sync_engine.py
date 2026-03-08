"""Sync engine — transforms and writes records from source to destination folders.

Thin orchestration layer over the Rust scratch_engine. Rust handles git I/O,
matching, transformation, and file writing. Python handles DB and orchestration.

Two-phase sync: DATA then FOREIGN_KEY_MAPPING (for FK resolution).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from app import db
from app.config import settings
from app.routes._helpers import flatten_folders, repo_id_for_folder

try:
    import scratch_engine
except ImportError:
    scratch_engine = None


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class SyncResult:
    created: int = 0
    updated: int = 0
    created_paths: list[str] = field(default_factory=list)
    updated_paths: list[str] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)

    def merge(self, other: SyncResult):
        self.created += other.created
        self.updated += other.updated
        self.created_paths.extend(other.created_paths)
        self.updated_paths.extend(other.updated_paths)
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def run_sync(sync_id: str, workbook_id: str) -> SyncResult:
    """Run a sync end-to-end: match, transform, write. Records a job in SQLite."""
    if scratch_engine is None:
        return SyncResult(errors=[{"source_id": "", "error": "scratch_engine not installed"}])

    sync = db.get_sync(workbook_id, sync_id)
    if not sync:
        return SyncResult(errors=[{"source_id": "", "error": "Sync not found"}])

    workbook = db.get_workbook(workbook_id)
    if not workbook:
        return SyncResult(errors=[{"source_id": "", "error": "Workbook not found"}])

    mappings = sync.get("mappings", {})
    table_mappings = mappings.get("tableMappings", [])
    if not table_mappings:
        return SyncResult(errors=[{"source_id": "", "error": "No table mappings configured"}])

    ctx: dict = {"remoteIdMappings": {}, "fkRecordCache": {}}
    result = SyncResult()

    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)

    # Phase 1: DATA — create/update records
    for tm in table_mappings:
        r, ctx = await _sync_table_mapping(workbook, all_folders, tm, sync_id, "DATA", ctx)
        result.merge(r)

    # Phase 2: FOREIGN_KEY_MAPPING — resolve FK references
    for tm in table_mappings:
        if _has_fk_transformers(tm):
            r, ctx = await _sync_table_mapping(
                workbook, all_folders, tm, sync_id, "FOREIGN_KEY_MAPPING", ctx
            )
            result.merge(r)

    _record_job(workbook_id, sync_id, result)
    return result


# ---------------------------------------------------------------------------
# Core sync logic (per table mapping)
# ---------------------------------------------------------------------------


async def _sync_table_mapping(
    workbook: dict,
    all_folders: list[dict],
    table_mapping: dict,
    sync_id: str,
    phase: str,
    ctx: dict,
) -> tuple[SyncResult, dict]:
    result = SyncResult()
    src_folder_id = table_mapping["sourceDataFolderId"]
    dst_folder_id = table_mapping["destinationDataFolderId"]

    src_folder = next((f for f in all_folders if f["id"] == src_folder_id), None)
    dst_folder = next((f for f in all_folders if f["id"] == dst_folder_id), None)
    if not src_folder or not dst_folder:
        result.errors.append({"source_id": "", "error": "Source or destination folder not found"})
        return result, ctx

    referenced_folders = _resolve_referenced_folders(table_mapping, all_folders, workbook)

    try:
        result_json = await asyncio.to_thread(
            scratch_engine.run_sync,
            settings.git_service_url,
            json.dumps(table_mapping),
            repo_id_for_folder(src_folder, workbook),
            src_folder.get("path", ""),
            repo_id_for_folder(dst_folder, workbook),
            dst_folder.get("path", ""),
            phase,
            json.dumps(ctx),
            json.dumps(referenced_folders),
            f"Sync: {sync_id}",
        )
        parsed = json.loads(result_json)
    except Exception as e:
        result.errors.append({"source_id": "", "error": f"Rust engine error: {e}"})
        return result, ctx

    # Unpack output
    output = parsed.get("output", {})
    updated_ctx = parsed.get("context", ctx)
    sync_result = output.get("result", {})

    result.created = sync_result.get("created", 0)
    result.updated = sync_result.get("updated", 0)
    result.created_paths = sync_result.get("createdPaths", [])
    result.updated_paths = sync_result.get("updatedPaths", [])
    for e in sync_result.get("errors", []):
        result.errors.append({"source_id": e.get("sourceId", ""), "error": e.get("message", "")})
    for w in sync_result.get("warnings", []):
        result.warnings.append({"source_id": w.get("sourceId", ""), "warning": w.get("message", "")})

    return result, updated_ctx


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_referenced_folders(
    table_mapping: dict, all_folders: list[dict], workbook: dict
) -> list[dict]:
    """Build the list of referenced folders for FK cache population."""
    referenced_folder_ids: set[str] = set()
    for mapping in table_mapping.get("columnMappings", []):
        for config in _get_transformer_configs(mapping):
            opts = config.get("options", {})
            if config.get("type") == "lookup_field" and "referencedDataFolderId" in opts:
                referenced_folder_ids.add(opts["referencedDataFolderId"])

    result = []
    for folder_id in referenced_folder_ids:
        folder = next((f for f in all_folders if f["id"] == folder_id), None)
        if not folder:
            continue
        result.append({
            "folderId": folder_id,
            "repoId": repo_id_for_folder(folder, workbook),
            "folderPath": folder.get("path", ""),
        })
    return result


def _get_transformer_configs(mapping: dict) -> list[dict]:
    """Normalize column mapping transformer config(s) into a list."""
    if mapping.get("transformers"):
        return mapping["transformers"]
    if mapping.get("transformer"):
        return [mapping["transformer"]]
    return []


def _has_fk_transformers(table_mapping: dict) -> bool:
    """Check if any column mapping uses FK-related transformers."""
    for mapping in table_mapping.get("columnMappings", []):
        for config in _get_transformer_configs(mapping):
            if config.get("type") in ("source_fk_to_dest_fk", "lookup_field"):
                return True
    return False


def _record_job(workbook_id: str, sync_id: str, result: SyncResult) -> None:
    """Save a job record to SQLite."""
    try:
        db.create_job(
            workbook_id,
            job_type="sync",
            result_data={
                "syncId": sync_id,
                "created": result.created,
                "updated": result.updated,
                "createdPaths": result.created_paths[:100],
                "updatedPaths": result.updated_paths[:100],
                "errors": result.errors[:100],
                "warnings": result.warnings[:100],
            },
        )
    except Exception:
        pass  # Job recording is non-critical
