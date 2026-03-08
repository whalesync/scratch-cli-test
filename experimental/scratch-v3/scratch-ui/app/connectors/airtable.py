"""Airtable connector. Single file = complete connector definition."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.connectors.base import Connector, Field, OAuthFlow, TablePreview

BASE_URL = "https://api.airtable.com/v0"
DEFAULT_RETRY_AFTER = 30


class Airtable(Connector):
    name = "airtable"
    display_name = "Airtable"
    auth_type = "API_KEY"
    auth = OAuthFlow(
        authorize_url="https://airtable.com/oauth2/v1/authorize",
        token_url="https://airtable.com/oauth2/v1/token",
        scopes=["data.records:read", "data.records:write", "schema.bases:read"],
    )
    fields = [
        Field("apiKey", "Personal Access Token", secret=True, placeholder="pat..."),
    ]

    # -- internal helpers -----------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.credentials['apiKey']}"}

    async def _request(
        self,
        client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Make an HTTP request with automatic retry on 429 rate-limit responses."""
        while True:
            response = await client.request(
                method,
                f"{BASE_URL}{path}",
                headers=self._headers(),
                params=params,
                json=json,
            )
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", DEFAULT_RETRY_AFTER))
                await asyncio.sleep(retry_after)
                continue
            response.raise_for_status()
            return response.json()

    # -- public API -----------------------------------------------------------

    async def test_connection(self) -> None:
        """Validate credentials by listing bases. Raises on failure."""
        async with httpx.AsyncClient() as client:
            await self._request(client, "GET", "/meta/bases")

    async def list_tables(self) -> list[TablePreview]:
        """List all tables across all bases the token can access."""
        tables: list[TablePreview] = []
        async with httpx.AsyncClient() as client:
            bases_resp = await self._request(client, "GET", "/meta/bases")
            for base in bases_resp.get("bases", []):
                base_id = base["id"]
                base_name = base["name"]
                schema_resp = await self._request(client, "GET", f"/meta/bases/{base_id}/tables")
                for table in schema_resp.get("tables", []):
                    tables.append(
                        TablePreview(
                            remote_id=[base_id, table["id"]],
                            name=f"{base_name} / {table['name']}",
                        )
                    )
        return tables

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        base_id, tbl_id = table_id
        async with httpx.AsyncClient() as client:
            data = await self._request(client, "GET", f"/meta/bases/{base_id}/tables")
            table = next((t for t in data.get("tables", []) if t["id"] == tbl_id), None)
            if not table:
                return None
            _READONLY_TYPES = {
                "formula", "rollup", "count", "lookup", "autoNumber",
                "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy",
            }
            _TYPE_MAP = {
                "singleLineText": "string", "multilineText": "string", "richText": "string",
                "email": "string", "url": "string", "phoneNumber": "string",
                "number": "number", "currency": "number", "percent": "number", "rating": "number",
                "checkbox": "boolean", "date": "date", "dateTime": "date",
                "singleSelect": "string", "multipleSelects": "array",
                "multipleRecordLinks": "array", "multipleAttachments": "array",
                "formula": "string", "rollup": "string", "count": "number",
                "lookup": "array", "autoNumber": "number",
            }
            columns = []
            for field in table.get("fields", []):
                ft = field.get("type", "singleLineText")
                columns.append({
                    "name": field["name"],
                    "type": _TYPE_MAP.get(ft, "string"),
                    "readonly": ft in _READONLY_TYPES,
                    "remoteFieldId": field.get("id"),
                    "nativeType": ft,
                })
            return {"name": table.get("name", ""), "idColumnRemoteId": "id", "columns": columns}

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        """Yield batches of records, paginating through the full table."""
        base_id, tbl_id = table_id
        offset: str | None = None
        async with httpx.AsyncClient() as client:
            while True:
                params: dict[str, str] = {}
                if offset is not None:
                    params["offset"] = offset
                data = await self._request(client, "GET", f"/{base_id}/{tbl_id}", params=params)
                records = data.get("records", [])
                if records:
                    yield records
                offset = data.get("offset")
                if not offset:
                    break

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        """Create records in batches of 10. Returns created records with IDs."""
        base_id, tbl_id = table_id
        created: list[dict] = []
        async with httpx.AsyncClient() as client:
            for i in range(0, len(records), self.batch_size("create")):
                batch = records[i : i + self.batch_size("create")]
                payload = {
                    "records": [{"fields": {k: v for k, v in r.items() if k not in ("id", "createdTime")}} for r in batch],
                    "typecast": True,
                }
                data = await self._request(client, "POST", f"/{base_id}/{tbl_id}", json=payload)
                created.extend(data.get("records", []))
        return created

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        """Update records in batches of 10."""
        base_id, tbl_id = table_id
        async with httpx.AsyncClient() as client:
            for i in range(0, len(records), self.batch_size("update")):
                batch = records[i : i + self.batch_size("update")]
                payload = {
                    "records": [
                        {
                            "id": r["id"],
                            "fields": {k: v for k, v in r.items() if k not in ("id", "createdTime")},
                        }
                        for r in batch
                    ],
                    "typecast": True,
                }
                await self._request(client, "PATCH", f"/{base_id}/{tbl_id}", json=payload)

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        """Delete records in batches of 10."""
        base_id, tbl_id = table_id
        async with httpx.AsyncClient() as client:
            for i in range(0, len(record_ids), self.batch_size("delete")):
                batch = record_ids[i : i + self.batch_size("delete")]
                params = [("records[]", rid) for rid in batch]
                await self._request(client, "DELETE", f"/{base_id}/{tbl_id}", params=params)

    def batch_size(self, operation: str = "create") -> int:
        return 10
