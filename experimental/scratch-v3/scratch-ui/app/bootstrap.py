"""One-time bootstrap: dump NestJS data into SQLite so scratch-ui runs standalone."""

from __future__ import annotations

import asyncio
import json
import sys

import httpx

from app.db import DB_PATH, get_db, init_db


async def bootstrap(api_url: str, api_token: str):
    print(f"Bootstrapping from {api_url} into {DB_PATH}")

    client = httpx.AsyncClient(
        base_url=api_url,
        headers={"Authorization": f"API-Token {api_token}"},
        timeout=30.0,
    )

    init_db()
    conn = get_db()

    # Clear existing data
    for table in ("job", "sync", "data_folder", "connector_account", "workbook"):
        conn.execute(f"DELETE FROM {table}")

    # -- Workbooks --
    workbooks = (await client.get("/workbook")).json()
    for wb in workbooks:
        conn.execute(
            "INSERT INTO workbook (id, name, organization_id, user_id) VALUES (?, ?, ?, ?)",
            (wb["id"], wb["name"], wb.get("organizationId", ""), wb.get("userId", "")),
        )
    print(f"  {len(workbooks)} workbooks")

    for wb in workbooks:
        wid = wb["id"]

        # -- Connections --
        connections = (await client.get(f"/workbooks/{wid}/connections")).json()
        for c in connections:
            conn.execute(
                """INSERT OR IGNORE INTO connector_account
                (id, workbook_id, service, display_name, auth_type) VALUES (?, ?, ?, ?, ?)""",
                (
                    c["id"], wid, c.get("service", ""),
                    c.get("displayName", ""),
                    c.get("authType", "USER_PROVIDED_PARAMS"),
                ),
            )
        print(f"  {len(connections)} connections for {wb['name']}")

        # -- Data Folders --
        folder_groups = (await client.get(f"/workbook/{wid}/data-folders/list")).json()
        folder_count = 0
        for group in folder_groups:
            for f in group.get("dataFolders", []):
                conn.execute(
                    """INSERT OR IGNORE INTO data_folder
                    (id, workbook_id, connector_account_id, connector_service, connector_display_name,
                     name, path, parent_id, table_id, options, last_sync_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        f["id"],
                        wid,
                        f.get("connectorAccountId"),
                        f.get("connectorService"),
                        f.get("connectorDisplayName"),
                        f["name"],
                        f["path"],
                        f.get("parentId"),
                        json.dumps(f.get("tableId", [])),
                        json.dumps(f.get("options", {})),
                        f.get("lastSyncTime"),
                    ),
                )
                folder_count += 1
        print(f"  {folder_count} data folders for {wb['name']}")

        # -- Syncs --
        syncs = (await client.get(f"/workbooks/{wid}/syncs")).json()
        for s in syncs:
            conn.execute(
                "INSERT OR IGNORE INTO sync (id, workbook_id, display_name, mappings) VALUES (?, ?, ?, ?)",
                (s["id"], wid, s.get("displayName", ""), json.dumps(s.get("mappings", {}))),
            )
        print(f"  {len(syncs)} syncs for {wb['name']}")

        # -- Jobs --
        try:
            jobs = (await client.get("/jobs", params={"workbookId": wid, "limit": 50})).json()
            for j in jobs:
                job_id = j.get("bullJobId") or j.get("dbJobId") or j.get("id", "")
                conn.execute(
                    """INSERT OR IGNORE INTO job
                    (id, workbook_id, type, state, created_at, completed_at, result)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        job_id,
                        wid,
                        j.get("type", ""),
                        j.get("state", j.get("status", "completed")),
                        j.get("createdAt", ""),
                        j.get("completedAt"),
                        json.dumps(j.get("result", {})),
                    ),
                )
            print(f"  {len(jobs)} jobs for {wb['name']}")
        except Exception as e:
            print(f"  jobs failed: {e}")

    conn.commit()
    conn.close()
    await client.aclose()
    print(f"\nDone. Database at {DB_PATH}")


if __name__ == "__main__":
    from app.config import settings
    url = sys.argv[1] if len(sys.argv) > 1 else settings.scratch_api_url
    token = sys.argv[2] if len(sys.argv) > 2 else settings.scratch_api_token
    asyncio.run(bootstrap(url, token))
