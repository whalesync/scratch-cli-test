"""JSON API routes for the Scratch CLI and AI agent integrations."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request

from app import db, services
from app.routes._helpers import (
    flatten_folders,
    list_files_in_folder,
    normalize,
)

router = APIRouter(prefix="/api")


def _not_found(e: LookupError):
    raise HTTPException(404, detail=str(e))


# -- Workspaces ---------------------------------------------------------------


@router.post("/workspaces")
async def create_workspace(request: Request):
    body = await request.json()
    name = body.get("name")
    if not name:
        raise HTTPException(400, detail="'name' required")
    user = getattr(request.state, "user", None)
    user_id = user.clerk_id if user else "local"
    ws = await services.create_workspace(name, user_id=user_id)
    return ws


@router.get("/workspaces")
async def list_workspaces(request: Request):
    user = getattr(request.state, "user", None)
    user_id = user.clerk_id if user else None
    workspaces = await services.list_workspaces(user_id=user_id)
    return {"workspaces": workspaces}


@router.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str):
    try:
        await services.delete_workspace(workspace_id)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/status")
async def workbook_status(workspace_id: str):
    try:
        return await services.get_workbook_status(workspace_id)
    except LookupError as e:
        _not_found(e)


@router.get("/workspaces/{workspace_id}/changes")
async def workbook_changes(workspace_id: str):
    try:
        changes = await services.get_changes(workspace_id)
    except LookupError as e:
        _not_found(e)
    return {"changes": changes}


# -- Connections ---------------------------------------------------------------


@router.post("/workspaces/{workspace_id}/connections")
async def create_connection(workspace_id: str, request: Request):
    body = await request.json()
    svc = body.get("service")
    creds = body.get("credentials", {})
    display_name = body.get("displayName")
    if not svc:
        raise HTTPException(400, detail="'service' required")
    if not creds:
        raise HTTPException(400, detail="'credentials' required")
    try:
        conn = await services.create_connection(workspace_id, svc, creds, display_name)
    except LookupError as e:
        _not_found(e)
    except ValueError as e:
        raise HTTPException(400, detail=str(e))
    except Exception as e:
        raise HTTPException(502, detail=f"Connection failed: {e}")
    return conn


@router.get("/workspaces/{workspace_id}/connections")
async def list_connections(workspace_id: str):
    connections = db.list_connections(workspace_id)
    return {
        "connections": [
            {
                "id": c["id"],
                "service": c.get("service", ""),
                "name": c.get("displayName", c.get("display_name", "")),
            }
            for c in connections
        ]
    }


@router.delete("/workspaces/{workspace_id}/connections/{conn_id}")
async def delete_connection(workspace_id: str, conn_id: str):
    try:
        await services.delete_connection(workspace_id, conn_id)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/connections/{conn_id}/test")
async def test_connection(workspace_id: str, conn_id: str):
    try:
        await services.test_connection(conn_id)
    except LookupError as e:
        _not_found(e)
    except Exception as e:
        raise HTTPException(502, detail=f"Connection failed: {e}")
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/connections/{conn_id}/tables")
async def discover_tables(workspace_id: str, conn_id: str):
    try:
        tables = await services.discover_tables(conn_id)
    except Exception as e:
        raise HTTPException(502, detail=f"Discovery failed: {e}")
    return {"tables": tables}


# -- Folders & files ----------------------------------------------------------


@router.post("/workspaces/{workspace_id}/folders")
async def link_tables(workspace_id: str, request: Request):
    body = await request.json()
    conn_id = body.get("connectionId")
    tables = body.get("tables")
    if not conn_id:
        raise HTTPException(400, detail="'connectionId' required")
    if not tables or not isinstance(tables, list):
        raise HTTPException(400, detail="'tables' array required")
    try:
        folders = await services.link_tables(workspace_id, conn_id, tables)
    except LookupError as e:
        _not_found(e)
    return {"folders": folders}


@router.get("/workspaces/{workspace_id}/folders")
async def list_folders(workspace_id: str):
    workbook = db.get_workbook(workspace_id)
    if not workbook:
        raise HTTPException(404, detail="Workspace not found")
    folder_groups = db.list_data_folders(workspace_id)
    all_folders = flatten_folders(folder_groups)
    return {
        "folders": [
            {
                "id": f.get("id"),
                "name": f.get("name", ""),
                "path": f.get("path", ""),
                "connectorAccountId": f.get("connectorAccountId", ""),
                "connectorService": f.get("connectorService", ""),
            }
            for f in all_folders
        ]
    }


@router.delete("/workspaces/{workspace_id}/folders/{folder_id}")
async def unlink_folder(workspace_id: str, folder_id: str):
    try:
        await services.unlink_folder(workspace_id, folder_id)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/folders/{path:path}/files")
async def list_folder_files(workspace_id: str, path: str):
    full_path = normalize(path)
    folder_groups = db.list_data_folders(workspace_id)
    all_folders = flatten_folders(folder_groups)
    target = next(
        (f for f in all_folders if (f.get("path") or "").rstrip("/") == full_path.rstrip("/")),
        None,
    )
    if not target:
        raise HTTPException(404, detail="Folder not found")

    items = await list_files_in_folder(workspace_id, target)
    file_items = [i for i in items if i.get("type") == "file" and not i.get("name", "").startswith(".")]
    return {
        "files": [
            {"name": f.get("name", ""), "path": normalize(f.get("path", ""))}
            for f in file_items
        ]
    }


@router.get("/workspaces/{workspace_id}/files/{path:path}")
async def read_file(workspace_id: str, path: str):
    try:
        return await services.read_file(workspace_id, normalize(path))
    except LookupError as e:
        _not_found(e)


@router.patch("/workspaces/{workspace_id}/files/{path:path}")
async def write_file(workspace_id: str, path: str, *, body: dict | None = None):
    if body is None:
        raise HTTPException(400, detail="Request body required")
    content = body.get("content")
    if content is None:
        raise HTTPException(400, detail="'content' field required")
    try:
        await services.write_file_content(workspace_id, normalize(path), content)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.patch("/workspaces/{workspace_id}/files/{path:path}/field")
async def write_field(workspace_id: str, path: str, *, body: dict | None = None):
    if body is None:
        raise HTTPException(400, detail="Request body required")
    field_path = body.get("field")
    if not field_path:
        raise HTTPException(400, detail="'field' path required")
    value = body.get("value")
    try:
        updated = await services.write_file_field(workspace_id, normalize(path), field_path, value)
    except LookupError as e:
        _not_found(e)
    return {"ok": True, "fields": updated}


# -- Pull ---------------------------------------------------------------------


@router.post("/workspaces/{workspace_id}/pull")
async def pull(workspace_id: str, connection_id: str | None = None):
    try:
        return await services.start_pull(workspace_id, connection_id)
    except LookupError as e:
        _not_found(e)


# -- Push (CLI -> server git) -------------------------------------------------


@router.post("/workspaces/{workspace_id}/push")
async def push_files(workspace_id: str, *, body: dict | None = None):
    if body is None:
        raise HTTPException(400, detail="Request body required")
    files = body.get("files")
    if not files or not isinstance(files, list):
        raise HTTPException(400, detail="'files' array required")
    try:
        return await services.push_files(workspace_id, files)
    except LookupError as e:
        _not_found(e)


# -- Download (server git -> CLI) ---------------------------------------------


@router.get("/workspaces/{workspace_id}/download")
async def download_files(workspace_id: str, branch: str = "dirty"):
    try:
        files = await services.download_all_files(workspace_id, branch=branch)
    except LookupError as e:
        _not_found(e)
    return {"files": files}


# -- Publish to external services ---------------------------------------------


@router.post("/workspaces/{workspace_id}/publish")
async def publish(workspace_id: str):
    try:
        return await services.start_push(workspace_id)
    except LookupError as e:
        _not_found(e)


# -- Git publish (dirty -> main) ----------------------------------------------


@router.post("/workspaces/{workspace_id}/publish-file")
async def publish_file(workspace_id: str, *, body: dict | None = None):
    if body is None:
        raise HTTPException(400, detail="Request body required")
    path = body.get("path")
    if not path:
        raise HTTPException(400, detail="'path' required")
    try:
        await services.publish_file(workspace_id, path)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/publish-all")
async def publish_all(workspace_id: str):
    result = await services.publish_all_files(workspace_id)
    return result


# -- Discard ------------------------------------------------------------------


@router.post("/workspaces/{workspace_id}/discard")
async def discard(workspace_id: str, *, body: dict | None = None):
    if body is None:
        raise HTTPException(400, detail="Request body required")
    path = body.get("path")
    if not path:
        raise HTTPException(400, detail="'path' required")
    try:
        await services.discard_changes(workspace_id, path)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


# -- Syncs --------------------------------------------------------------------


@router.post("/workspaces/{workspace_id}/syncs")
async def create_sync(workspace_id: str, request: Request):
    body = await request.json()
    try:
        sync = await services.create_sync(workspace_id, body)
    except LookupError as e:
        _not_found(e)
    return sync


@router.get("/workspaces/{workspace_id}/syncs")
async def list_syncs(workspace_id: str):
    syncs = db.list_syncs(workspace_id)
    return {
        "syncs": [
            {"id": s["id"], "name": s.get("displayName", ""), "mappings": s.get("mappings", {})}
            for s in syncs
        ]
    }


@router.get("/workspaces/{workspace_id}/syncs/{sync_id}")
async def get_sync(workspace_id: str, sync_id: str):
    try:
        return await services.get_sync(workspace_id, sync_id)
    except LookupError as e:
        _not_found(e)


@router.patch("/workspaces/{workspace_id}/syncs/{sync_id}")
async def update_sync(workspace_id: str, sync_id: str, request: Request):
    body = await request.json()
    try:
        return await services.update_sync(workspace_id, sync_id, body)
    except LookupError as e:
        _not_found(e)


@router.delete("/workspaces/{workspace_id}/syncs/{sync_id}")
async def delete_sync(workspace_id: str, sync_id: str):
    try:
        await services.delete_sync(workspace_id, sync_id)
    except LookupError as e:
        _not_found(e)
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/syncs/{sync_id}/run")
async def run_sync(workspace_id: str, sync_id: str):
    try:
        result = await services.execute_sync(sync_id, workspace_id)
    except LookupError as e:
        _not_found(e)
    return {"status": "completed", **result}


# -- Jobs ---------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/jobs")
async def list_jobs(workspace_id: str, limit: int = 20):
    jobs = db.list_jobs(workspace_id, limit=limit)
    return {
        "jobs": [
            {
                "id": j["id"],
                "type": j.get("type", ""),
                "status": j.get("state", "unknown"),
                "createdAt": j.get("createdAt", ""),
                "completedAt": j.get("completedAt"),
            }
            for j in jobs
        ]
    }


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    try:
        return services.get_job_status(job_id)
    except LookupError as e:
        _not_found(e)


# -- API Tokens (for CLI auth) ------------------------------------------------


@router.post("/auth/tokens")
async def create_api_token(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, detail="Not authenticated")
    body = await request.json()
    label = body.get("label", "CLI")
    raw_token = db.create_api_token(user.clerk_id, label=label)
    return {"token": raw_token}


@router.get("/auth/tokens")
async def list_api_tokens(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, detail="Not authenticated")
    tokens = db.list_api_tokens(user.clerk_id)
    return {"tokens": tokens}


@router.delete("/auth/tokens/{token_hash}")
async def delete_api_token(token_hash: str, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, detail="Not authenticated")
    db.delete_api_token(token_hash, user.clerk_id)
    return {"ok": True}
