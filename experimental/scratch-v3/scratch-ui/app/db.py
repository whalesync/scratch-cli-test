"""SQLite database — replaces PostgreSQL for the standalone prototype."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "scratch.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    clerk_id TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_token (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user(id),
    label TEXT NOT NULL DEFAULT 'CLI',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workbook (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_account (
    id TEXT PRIMARY KEY,
    workbook_id TEXT NOT NULL REFERENCES workbook(id),
    service TEXT NOT NULL,
    display_name TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'USER_PROVIDED_PARAMS',
    encrypted_credentials TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS data_folder (
    id TEXT PRIMARY KEY,
    workbook_id TEXT NOT NULL REFERENCES workbook(id),
    connector_account_id TEXT REFERENCES connector_account(id),
    connector_service TEXT,
    connector_display_name TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    parent_id TEXT,
    table_id TEXT,  -- JSON array
    options TEXT DEFAULT '{}',
    last_sync_time TEXT
);

CREATE TABLE IF NOT EXISTS sync (
    id TEXT PRIMARY KEY,
    workbook_id TEXT NOT NULL REFERENCES workbook(id),
    display_name TEXT NOT NULL,
    mappings TEXT NOT NULL DEFAULT '{}'  -- JSON
);

CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    workbook_id TEXT NOT NULL REFERENCES workbook(id),
    type TEXT,
    state TEXT DEFAULT 'completed',
    created_at TEXT,
    completed_at TEXT,
    result TEXT DEFAULT '{}'  -- JSON
);

CREATE TABLE IF NOT EXISTS file_index (
    workbook_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    record_id TEXT NOT NULL,
    last_seen_at TEXT,
    PRIMARY KEY (workbook_id, folder_path, record_id)
);
"""


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return dict(row)


def rows_to_list(rows: list[sqlite3.Row]) -> list[dict]:
    return [dict(r) for r in rows]


# -- Users --

def upsert_user(clerk_id: str, email: str | None = None, name: str | None = None) -> dict:
    from datetime import datetime, timezone
    conn = get_db()
    conn.execute(
        "INSERT INTO user (id, clerk_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT (clerk_id) DO UPDATE SET email = excluded.email, name = excluded.name",
        (clerk_id, clerk_id, email, name, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM user WHERE clerk_id = ?", (clerk_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


def get_user(clerk_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM user WHERE clerk_id = ?", (clerk_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


# -- API Tokens --

def create_api_token(user_id: str, label: str = "CLI") -> str:
    """Create a new API token for a user. Returns the raw token (only shown once)."""
    import hashlib
    import secrets
    from datetime import datetime, timezone

    raw_token = f"sk_{secrets.token_urlsafe(32)}"
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    conn = get_db()
    conn.execute(
        "INSERT INTO api_token (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)",
        (token_hash, user_id, label, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()
    return raw_token


def verify_api_token(raw_token: str) -> dict | None:
    """Look up a raw API token. Returns the user row if valid, None otherwise."""
    import hashlib

    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    conn = get_db()
    row = conn.execute(
        "SELECT u.* FROM api_token t JOIN user u ON t.user_id = u.id WHERE t.token_hash = ?",
        (token_hash,),
    ).fetchone()
    conn.close()
    return row_to_dict(row)


def list_api_tokens(user_id: str) -> list[dict]:
    conn = get_db()
    rows = rows_to_list(
        conn.execute(
            "SELECT token_hash, label, created_at FROM api_token WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    )
    conn.close()
    return rows


def delete_api_token(token_hash: str, user_id: str) -> None:
    conn = get_db()
    conn.execute("DELETE FROM api_token WHERE token_hash = ? AND user_id = ?", (token_hash, user_id))
    conn.commit()
    conn.close()


# -- Workbooks --

def list_workbooks(user_id: str | None = None) -> list[dict]:
    conn = get_db()
    if user_id:
        rows = conn.execute("SELECT * FROM workbook WHERE user_id = ?", (user_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM workbook").fetchall()
    conn.close()
    return rows_to_list(rows)


def get_workbook(workbook_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM workbook WHERE id = ?", (workbook_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


def create_workspace(name: str, user_id: str = "local") -> dict:
    import secrets
    ws_id = f"ws_{secrets.token_urlsafe(8)}"
    conn = get_db()
    conn.execute(
        "INSERT INTO workbook (id, name, organization_id, user_id) VALUES (?, ?, ?, ?)",
        (ws_id, name, user_id, user_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM workbook WHERE id = ?", (ws_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


def delete_workspace(workspace_id: str) -> None:
    conn = get_db()
    # CASCADE: file_index → job → sync → data_folder → connector_account → workbook
    conn.execute("DELETE FROM file_index WHERE workbook_id = ?", (workspace_id,))
    conn.execute("DELETE FROM job WHERE workbook_id = ?", (workspace_id,))
    conn.execute("DELETE FROM sync WHERE workbook_id = ?", (workspace_id,))
    conn.execute("DELETE FROM data_folder WHERE workbook_id = ?", (workspace_id,))
    conn.execute("DELETE FROM connector_account WHERE workbook_id = ?", (workspace_id,))
    conn.execute("DELETE FROM workbook WHERE id = ?", (workspace_id,))
    conn.commit()
    conn.close()


# -- Data Folders --

def list_data_folders(workbook_id: str) -> list[dict]:
    """Return folders grouped by connection (matching NestJS format)."""
    conn = get_db()
    folders = rows_to_list(
        conn.execute("SELECT * FROM data_folder WHERE workbook_id = ? ORDER BY path", (workbook_id,)).fetchall()
    )
    connections = rows_to_list(
        conn.execute("SELECT * FROM connector_account WHERE workbook_id = ?", (workbook_id,)).fetchall()
    )
    conn.close()

    # Parse table_id JSON
    for f in folders:
        if f.get("table_id"):
            try:
                f["tableId"] = json.loads(f["table_id"])
            except (json.JSONDecodeError, TypeError):
                f["tableId"] = []
        if f.get("options"):
            try:
                f["options"] = json.loads(f["options"])
            except (json.JSONDecodeError, TypeError):
                f["options"] = {}
        # Map snake_case to camelCase for template compatibility
        f["connectorAccountId"] = f.get("connector_account_id", "")
        f["connectorService"] = f.get("connector_service", "")
        f["connectorDisplayName"] = f.get("connector_display_name", "")
        f["workbookId"] = f.get("workbook_id", "")
        f["parentId"] = f.get("parent_id")
        f["lastSyncTime"] = f.get("last_sync_time")

    # Group by connection
    conn_map: dict[str, dict] = {}
    for c in connections:
        conn_map[c["id"]] = {
            "connectorAccountId": c["id"],
            "service": c["service"],
            "displayName": c["display_name"],
            "dataFolders": [],
        }

    ungrouped = []
    for f in folders:
        cid = f.get("connector_account_id", "")
        if cid in conn_map:
            conn_map[cid]["dataFolders"].append(f)
        else:
            ungrouped.append(f)

    groups = [g for g in conn_map.values() if g["dataFolders"]]
    if ungrouped:
        groups.append({"connectorAccountId": None, "dataFolders": ungrouped})
    return groups


def get_data_folder(folder_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM data_folder WHERE id = ?", (folder_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    result = row_to_dict(row)
    result["connectorAccountId"] = result.get("connector_account_id", "")
    result["connectorService"] = result.get("connector_service", "")
    result["connectorDisplayName"] = result.get("connector_display_name", "")
    result["workbookId"] = result.get("workbook_id", "")
    if result.get("table_id"):
        try:
            result["tableId"] = json.loads(result["table_id"])
        except (json.JSONDecodeError, TypeError):
            result["tableId"] = []
    return result


def delete_data_folder(folder_id: str) -> None:
    conn = get_db()
    # Get folder info for file_index cleanup
    row = conn.execute("SELECT workbook_id, path FROM data_folder WHERE id = ?", (folder_id,)).fetchone()
    if row:
        conn.execute(
            "DELETE FROM file_index WHERE workbook_id = ? AND folder_path = ?",
            (row["workbook_id"], row["path"]),
        )
    conn.execute("DELETE FROM data_folder WHERE id = ?", (folder_id,))
    conn.commit()
    conn.close()


def update_folder_sync_time(folder_id: str) -> None:
    from datetime import datetime, timezone
    conn = get_db()
    conn.execute(
        "UPDATE data_folder SET last_sync_time = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), folder_id),
    )
    conn.commit()
    conn.close()


def create_data_folder(payload: dict) -> dict:
    conn = get_db()
    import secrets
    folder_id = f"dfd_{secrets.token_urlsafe(8)}"
    name = payload["name"]
    path = payload.get("path") or f"/{name}"
    table_id = json.dumps(payload["tableId"]) if isinstance(payload.get("tableId"), list) else payload.get("tableId", "[]")
    conn.execute(
        "INSERT INTO data_folder"
        " (id, workbook_id, connector_account_id, connector_service, connector_display_name, name, path, table_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            folder_id, payload["workbookId"], payload.get("connectorAccountId"),
            payload.get("connectorService", ""), payload.get("connectorDisplayName", ""),
            name, path, table_id,
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM data_folder WHERE id = ?", (folder_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


# -- Connections --

def list_connections(workbook_id: str) -> list[dict]:
    conn = get_db()
    rows = rows_to_list(
        conn.execute("SELECT * FROM connector_account WHERE workbook_id = ?", (workbook_id,)).fetchall()
    )
    conn.close()
    for r in rows:
        r["displayName"] = r.get("display_name", "")
        r["authType"] = r.get("auth_type", "")
        r["workbookId"] = r.get("workbook_id", "")
    return rows


def get_connection(connector_account_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM connector_account WHERE id = ?", (connector_account_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    result = row_to_dict(row)
    result["displayName"] = result.get("display_name", "")
    result["authType"] = result.get("auth_type", "")
    result["workbookId"] = result.get("workbook_id", "")
    return result


def create_connection(workbook_id: str, payload: dict) -> dict:
    conn = get_db()
    import secrets
    conn_id = f"coa_{secrets.token_urlsafe(8)}"
    conn.execute(
        "INSERT INTO connector_account (id, workbook_id, service, display_name, auth_type, encrypted_credentials)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            conn_id, workbook_id, payload["service"],
            payload.get("displayName", ""),
            payload.get("authType", "USER_PROVIDED_PARAMS"),
            payload.get("encryptedCredentials", "{}"),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM connector_account WHERE id = ?", (conn_id,)).fetchone()
    conn.close()
    result = row_to_dict(row)
    result["connectorAccountId"] = result["id"]
    return result


# -- Syncs --

def list_syncs(workbook_id: str) -> list[dict]:
    conn = get_db()
    rows = rows_to_list(
        conn.execute("SELECT * FROM sync WHERE workbook_id = ?", (workbook_id,)).fetchall()
    )
    conn.close()
    for r in rows:
        r["displayName"] = r.get("display_name", "")
        r["workbookId"] = r.get("workbook_id", "")
        if isinstance(r.get("mappings"), str):
            try:
                r["mappings"] = json.loads(r["mappings"])
            except (json.JSONDecodeError, TypeError):
                r["mappings"] = {}
    return rows


def get_sync(workbook_id: str, sync_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM sync WHERE id = ? AND workbook_id = ?", (sync_id, workbook_id)).fetchone()
    conn.close()
    if row is None:
        return None
    result = row_to_dict(row)
    result["displayName"] = result.get("display_name", "")
    result["workbookId"] = result.get("workbook_id", "")
    if isinstance(result.get("mappings"), str):
        try:
            result["mappings"] = json.loads(result["mappings"])
        except (json.JSONDecodeError, TypeError):
            result["mappings"] = {}
    return result


def create_sync(workbook_id: str, payload: dict) -> dict:
    conn = get_db()
    import secrets
    sync_id = f"syn_{secrets.token_urlsafe(8)}"
    conn.execute(
        "INSERT INTO sync (id, workbook_id, display_name, mappings) VALUES (?, ?, ?, ?)",
        (sync_id, workbook_id, payload.get("displayName", ""), json.dumps(payload.get("mappings", {}))),
    )
    conn.commit()
    conn.close()
    return get_sync(workbook_id, sync_id)


def update_sync(workbook_id: str, sync_id: str, payload: dict) -> dict:
    conn = get_db()
    sets = []
    vals = []
    if "displayName" in payload:
        sets.append("display_name = ?")
        vals.append(payload["displayName"])
    if "mappings" in payload:
        sets.append("mappings = ?")
        vals.append(json.dumps(payload["mappings"]))
    if sets:
        vals.extend([sync_id, workbook_id])
        conn.execute(f"UPDATE sync SET {', '.join(sets)} WHERE id = ? AND workbook_id = ?", vals)
        conn.commit()
    conn.close()
    return get_sync(workbook_id, sync_id)


def delete_sync(workbook_id: str, sync_id: str) -> None:
    conn = get_db()
    conn.execute("DELETE FROM sync WHERE id = ? AND workbook_id = ?", (sync_id, workbook_id))
    conn.commit()
    conn.close()


# -- Connections (delete) --

def update_connection(connector_account_id: str, encrypted_credentials: str, display_name: str | None = None) -> None:
    conn = get_db()
    if display_name is not None:
        conn.execute(
            "UPDATE connector_account SET encrypted_credentials = ?, display_name = ? WHERE id = ?",
            (encrypted_credentials, display_name, connector_account_id),
        )
    else:
        conn.execute(
            "UPDATE connector_account SET encrypted_credentials = ? WHERE id = ?",
            (encrypted_credentials, connector_account_id),
        )
    conn.commit()
    conn.close()


def delete_connection(connector_account_id: str) -> None:
    conn = get_db()
    conn.execute("DELETE FROM data_folder WHERE connector_account_id = ?", (connector_account_id,))
    conn.execute("DELETE FROM connector_account WHERE id = ?", (connector_account_id,))
    conn.commit()
    conn.close()


# -- Jobs --

def create_job(workbook_id: str, job_type: str, result_data: dict | None = None, state: str | None = None) -> dict:
    conn = get_db()
    import secrets as _secrets
    from datetime import datetime, timezone

    job_id = f"job_{_secrets.token_urlsafe(8)}"
    now = datetime.now(timezone.utc).isoformat()
    if state is None:
        has_errors = bool(result_data and result_data.get("errors"))
        state = "failed" if has_errors else "completed"
    completed_at = now if state not in ("active", "created") else None
    conn.execute(
        "INSERT INTO job (id, workbook_id, type, state, created_at, completed_at, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (job_id, workbook_id, job_type, state, now, completed_at, json.dumps(result_data or {})),
    )
    conn.commit()
    conn.close()
    return {"id": job_id, "state": state}


def get_job(job_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    r = row_to_dict(row)
    r["workbookId"] = r.get("workbook_id", "")
    return r


def update_job(job_id: str, state: str, result_data: dict | None = None) -> None:
    conn = get_db()
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    if result_data is not None:
        conn.execute(
            "UPDATE job SET state = ?, result = ?, completed_at = ? WHERE id = ?",
            (state, json.dumps(result_data), now, job_id),
        )
    else:
        conn.execute("UPDATE job SET state = ? WHERE id = ?", (state, job_id))
    conn.commit()
    conn.close()


def list_jobs(workbook_id: str, limit: int = 50) -> list[dict]:
    conn = get_db()
    rows = rows_to_list(
        conn.execute(
            "SELECT * FROM job WHERE workbook_id = ? ORDER BY created_at DESC LIMIT ?",
            (workbook_id, limit),
        ).fetchall()
    )
    conn.close()
    for r in rows:
        r["workbookId"] = r.get("workbook_id", "")
        r["createdAt"] = r.get("created_at", "")
        r["completedAt"] = r.get("completed_at")
        if isinstance(r.get("result"), str):
            try:
                r["result"] = json.loads(r["result"])
            except (json.JSONDecodeError, TypeError):
                r["result"] = {}
        # Map fields for run-row template
        r["publicProgress"] = r.get("result", {}).get("publicProgress", {})
        r["processedOn"] = r.get("created_at")
        r["finishedOn"] = r.get("completed_at")
        r["failedReason"] = r.get("result", {}).get("failedReason")
    return rows


# -- File Index --

def upsert_file_index(workbook_id: str, folder_path: str, filename: str, record_id: str) -> None:
    from datetime import datetime, timezone
    conn = get_db()
    conn.execute(
        "INSERT INTO file_index (workbook_id, folder_path, filename, record_id, last_seen_at)"
        " VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT (workbook_id, folder_path, record_id)"
        " DO UPDATE SET filename = excluded.filename, last_seen_at = excluded.last_seen_at",
        (workbook_id, folder_path, filename, record_id, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def upsert_file_index_batch(entries: list[dict]) -> None:
    if not entries:
        return
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    conn.executemany(
        "INSERT INTO file_index (workbook_id, folder_path, filename, record_id, last_seen_at)"
        " VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT (workbook_id, folder_path, record_id)"
        " DO UPDATE SET filename = excluded.filename, last_seen_at = excluded.last_seen_at",
        [(e["workbook_id"], e["folder_path"], e["filename"], e["record_id"], now) for e in entries],
    )
    conn.commit()
    conn.close()


def get_file_index_all(workbook_id: str) -> dict[str, str]:
    """Return {folder_path/filename: record_id} for all indexed files in a workbook."""
    conn = get_db()
    rows = conn.execute(
        "SELECT folder_path, filename, record_id FROM file_index WHERE workbook_id = ?",
        (workbook_id,),
    ).fetchall()
    conn.close()
    result: dict[str, str] = {}
    for r in rows:
        path = f"{r['folder_path']}/{r['filename']}" if r["folder_path"] else r["filename"]
        result[path] = r["record_id"]
    return result


def get_record_id(workbook_id: str, folder_path: str, filename: str) -> str | None:
    conn = get_db()
    row = conn.execute(
        "SELECT record_id FROM file_index WHERE workbook_id = ? AND folder_path = ? AND filename = ?",
        (workbook_id, folder_path, filename),
    ).fetchone()
    conn.close()
    return row["record_id"] if row else None


def delete_file_index(workbook_id: str, folder_path: str, record_id: str) -> None:
    conn = get_db()
    conn.execute(
        "DELETE FROM file_index WHERE workbook_id = ? AND folder_path = ? AND record_id = ?",
        (workbook_id, folder_path, record_id),
    )
    conn.commit()
    conn.close()
