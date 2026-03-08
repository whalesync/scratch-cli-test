from __future__ import annotations

import httpx

from app.config import settings


class ScratchClient:
    """Async HTTP client wrapping the NestJS server API."""

    def __init__(self, base_url: str = settings.scratch_api_url, api_token: str = settings.scratch_api_token):
        headers = {}
        if api_token:
            headers["Authorization"] = f"API-Token {api_token}"
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=30.0,
        )

    async def close(self) -> None:
        await self._client.aclose()

    # -- Workbooks --

    async def list_workbooks(self) -> list[dict]:
        r = await self._client.get("/workbook")
        r.raise_for_status()
        return r.json()

    async def get_workbook(self, workbook_id: str) -> dict:
        r = await self._client.get(f"/workbook/{workbook_id}")
        r.raise_for_status()
        return r.json()

    async def list_data_folders(self, workbook_id: str) -> list[dict]:
        r = await self._client.get(f"/workbook/{workbook_id}/data-folders/list")
        r.raise_for_status()
        return r.json()

    # -- Files --

    async def list_files(self, workbook_id: str, folder_id: str) -> list[dict]:
        r = await self._client.get(f"/workbooks/{workbook_id}/files/list/by-folder", params={"folderId": folder_id})
        r.raise_for_status()
        return r.json()

    async def get_file(self, workbook_id: str, path: str) -> dict:
        r = await self._client.get(f"/workbooks/{workbook_id}/files/by-path", params={"path": path})
        r.raise_for_status()
        return r.json()

    async def update_file(self, workbook_id: str, path: str, content: str) -> None:
        r = await self._client.patch(
            f"/workbooks/{workbook_id}/files/by-path",
            params={"path": path},
            json={"content": content},
        )
        r.raise_for_status()

    async def publish_file(self, workbook_id: str, path: str) -> None:
        r = await self._client.post(f"/workbooks/{workbook_id}/files/publish", json={"path": path})
        r.raise_for_status()

    async def discard_changes(self, workbook_id: str, path: str | None = None) -> None:
        body: dict = {}
        if path:
            body["path"] = path
        r = await self._client.post(f"/workbook/{workbook_id}/discard-changes", json=body)
        r.raise_for_status()

    # -- Git Status --

    async def get_dirty_files(self, workbook_id: str) -> list[dict]:
        r = await self._client.get(f"/scratch-git/{workbook_id}/git-status")
        r.raise_for_status()
        return r.json()

    # -- Connections --

    async def list_connections(self, workbook_id: str) -> list[dict]:
        r = await self._client.get(f"/workbooks/{workbook_id}/connections")
        r.raise_for_status()
        return r.json()

    async def create_connection(self, workbook_id: str, payload: dict) -> dict:
        r = await self._client.post(f"/workbooks/{workbook_id}/connections", json=payload)
        r.raise_for_status()
        return r.json()

    async def list_tables(self, workbook_id: str, conn_id: str) -> dict:
        r = await self._client.get(f"/workbooks/{workbook_id}/connections/{conn_id}/tables")
        r.raise_for_status()
        return r.json()

    async def test_connection(self, workbook_id: str, conn_id: str) -> dict:
        r = await self._client.post(f"/workbooks/{workbook_id}/connections/{conn_id}/test")
        r.raise_for_status()
        return r.json()

    # -- Schema --

    async def get_schema_paths(self, folder_id: str) -> list[dict]:
        r = await self._client.get(f"/data-folder/{folder_id}/schema-paths")
        r.raise_for_status()
        return r.json()

    # -- Data Folders --

    async def create_data_folder(self, payload: dict) -> dict:
        r = await self._client.post("/data-folder/create", json=payload)
        r.raise_for_status()
        return r.json()

    async def delete_data_folder(self, folder_id: str) -> None:
        r = await self._client.delete(f"/data-folder/{folder_id}")
        r.raise_for_status()

    # -- Pull --

    async def pull_files(self, workbook_id: str, folder_ids: list[str] | None = None) -> dict:
        body: dict = {}
        if folder_ids:
            body["dataFolderIds"] = folder_ids
        r = await self._client.post(f"/workbook/{workbook_id}/pull-files", json=body)
        r.raise_for_status()
        return r.json()

    # -- Jobs --

    async def list_jobs(self, workbook_id: str, limit: int = 50) -> list[dict]:
        r = await self._client.get("/jobs", params={"workbookId": workbook_id, "limit": limit})
        r.raise_for_status()
        return r.json()

    async def cancel_job(self, job_id: str) -> dict:
        r = await self._client.post(f"/jobs/{job_id}/cancel")
        r.raise_for_status()
        return r.json()

    # -- Syncs --

    async def list_syncs(self, workbook_id: str) -> list[dict]:
        r = await self._client.get(f"/workbooks/{workbook_id}/syncs")
        r.raise_for_status()
        return r.json()

    async def get_sync(self, workbook_id: str, sync_id: str) -> dict:
        r = await self._client.get(f"/workbooks/{workbook_id}/syncs/{sync_id}")
        r.raise_for_status()
        return r.json()

    async def create_sync(self, workbook_id: str, payload: dict) -> dict:
        r = await self._client.post(f"/workbooks/{workbook_id}/syncs", json=payload)
        r.raise_for_status()
        return r.json()

    async def update_sync(self, workbook_id: str, sync_id: str, payload: dict) -> dict:
        r = await self._client.patch(f"/workbooks/{workbook_id}/syncs/{sync_id}", json=payload)
        r.raise_for_status()
        return r.json()

    async def delete_sync(self, workbook_id: str, sync_id: str) -> None:
        r = await self._client.delete(f"/workbooks/{workbook_id}/syncs/{sync_id}")
        r.raise_for_status()

    async def run_sync(self, workbook_id: str, sync_id: str) -> dict:
        r = await self._client.post(f"/workbooks/{workbook_id}/syncs/{sync_id}/run")
        r.raise_for_status()
        return r.json()
