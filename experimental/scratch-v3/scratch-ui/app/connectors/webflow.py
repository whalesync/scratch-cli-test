"""Webflow CMS connector — calls the Webflow v2 REST API directly via httpx."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.connectors.base import Connector, Field, OAuthFlow, TablePreview

BASE_URL = "https://api.webflow.com/v2"

# Ecommerce collection slugs that should be excluded from list_tables.
_ECOMMERCE_SLUGS = {"products", "categories", "skus"}

# Default seconds to wait when a 429 has no Retry-After header.
_DEFAULT_RETRY_AFTER = 30

# Maximum number of retries for rate-limited requests.
_MAX_RETRIES = 5


class Webflow(Connector):
    name = "webflow"
    display_name = "Webflow"
    auth_type = "API_KEY"
    auth = OAuthFlow(
        authorize_url="https://webflow.com/oauth/authorize",
        token_url="https://api.webflow.com/oauth/access_token",
        scopes=["read", "write"],
    )
    fields = [
        Field("apiKey", "API Token", secret=True),
    ]

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    def _headers(self) -> dict[str, str]:
        api_key = self.credentials.get("apiKey", "")
        return {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    async def _request(
        self,
        client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        json: dict | list | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Send an HTTP request to the Webflow v2 API with 429 retry logic."""

        url = f"{BASE_URL}{path}"

        for _attempt in range(_MAX_RETRIES):
            response = await client.request(
                method,
                url,
                headers=self._headers(),
                json=json,
                params=params,
                timeout=60.0,
            )

            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", _DEFAULT_RETRY_AFTER))
                await asyncio.sleep(retry_after)
                continue

            response.raise_for_status()
            if response.status_code == 204 or not response.content:
                return {}
            return response.json()  # type: ignore[no-any-return]

        # Exhausted retries — let the last 429 bubble up as an error.
        raise httpx.HTTPStatusError(
            "Rate limited: too many retries",
            request=httpx.Request(method, url),
            response=response,  # type: ignore[possibly-undefined]
        )

    # --------------------------------------------------------------------- #
    # Connector interface
    # --------------------------------------------------------------------- #

    async def test_connection(self) -> None:
        """Validate credentials by listing sites."""
        async with httpx.AsyncClient() as client:
            await self._request(client, "GET", "/sites")

    async def list_tables(self) -> list[TablePreview]:
        """Return all non-ecommerce CMS collections across every site."""
        tables: list[TablePreview] = []
        async with httpx.AsyncClient() as client:
            sites_data = await self._request(client, "GET", "/sites")
            sites: list[dict[str, Any]] = sites_data.get("sites", [])

            for site in sites:
                site_id: str = site["id"]
                site_name: str = site.get("displayName", site.get("name", site_id))

                collections_data = await self._request(client, "GET", f"/sites/{site_id}/collections")
                collections: list[dict[str, Any]] = collections_data.get("collections", [])

                for col in collections:
                    slug = col.get("slug", "")
                    if slug in _ECOMMERCE_SLUGS:
                        continue

                    col_id: str = col["id"]
                    col_name: str = col.get("displayName", col.get("name", col_id))

                    tables.append(
                        TablePreview(
                            remote_id=[site_id, col_id],
                            name=f"{site_name} / {col_name}",
                        )
                    )

        return tables

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        _site_id, collection_id = table_id
        _TYPE_MAP = {
            "PlainText": "string", "RichText": "string", "Number": "number",
            "Bool": "boolean", "Date": "date", "DateTime": "date",
            "Link": "string", "Email": "string", "Phone": "string",
            "Color": "string", "Image": "object", "File": "object",
            "Video": "object", "Set": "array", "Option": "string",
            "Reference": "array", "MultiReference": "array",
        }
        async with httpx.AsyncClient() as client:
            data = await self._request(client, "GET", f"/collections/{collection_id}")
            columns = []
            for field in data.get("fields", []):
                ft = field.get("type", "PlainText")
                columns.append({
                    "name": field.get("displayName", field.get("slug", "")),
                    "type": _TYPE_MAP.get(ft, "string"),
                    "readonly": not field.get("isEditable", True),
                    "slug": field.get("slug"),
                    "nativeType": ft,
                })
            return {
                "name": data.get("displayName", data.get("slug", "")),
                "idColumnRemoteId": "id",
                "columns": columns,
            }

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        """Paginate through all items in a collection, yielding batches."""
        _site_id, collection_id = table_id
        offset = 0
        limit = 100

        async with httpx.AsyncClient() as client:
            while True:
                data = await self._request(
                    client,
                    "GET",
                    f"/collections/{collection_id}/items",
                    params={"offset": offset, "limit": limit},
                )

                items: list[dict[str, Any]] = data.get("items", [])
                if items:
                    yield items

                pagination = data.get("pagination", {})
                total: int = pagination.get("total", 0)
                offset += limit

                if offset >= total:
                    break

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        """Bulk-create items in a Webflow collection. Returns created items."""
        _site_id, collection_id = table_id

        field_data_list = []
        for record in records:
            if "fieldData" in record:
                field_data_list.append(record["fieldData"])
            else:
                cleaned = {k: v for k, v in record.items() if k not in ("id", "cmsLocaleId", "isArchived", "isDraft", "createdOn", "lastPublished", "lastUpdated")}
                field_data_list.append(cleaned)

        async with httpx.AsyncClient() as client:
            result = await self._request(
                client,
                "POST",
                f"/collections/{collection_id}/items",
                json={"fieldData": field_data_list},
            )

        return result.get("items", [])  # type: ignore[no-any-return]

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        """Bulk-update items in a Webflow collection."""
        _site_id, collection_id = table_id

        items_payload = []
        for record in records:
            record_id = record.get("id", "")
            field_data = record.get("fieldData", {})
            if not field_data:
                field_data = {k: v for k, v in record.items() if k not in ("id", "cmsLocaleId", "isArchived", "isDraft", "createdOn", "lastPublished", "lastUpdated")}
            items_payload.append({"id": record_id, "fieldData": field_data})

        async with httpx.AsyncClient() as client:
            await self._request(
                client,
                "PATCH",
                f"/collections/{collection_id}/items",
                json={"items": items_payload},
            )

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        """Bulk-delete items from a Webflow collection."""
        _site_id, collection_id = table_id
        items_payload = [{"id": rid} for rid in record_ids]

        async with httpx.AsyncClient() as client:
            await self._request(
                client,
                "DELETE",
                f"/collections/{collection_id}/items",
                json={"items": items_payload},
            )

    def batch_size(self, operation: str = "create") -> int:
        return 100
