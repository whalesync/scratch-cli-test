"""WordPress connector — talks to the WordPress REST API (WP >= 4.7)."""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.connectors.base import Connector, Field, TablePreview

# Internal/utility post types that should be hidden from users.
_EXCLUDED_TYPES: set[str] = {
    "attachment",
    "nav_menu_item",
    "wp_block",
    "wp_template",
    "wp_template_part",
    "wp_navigation",
    "wp_font_family",
    "wp_font_face",
    "wp_global_styles",
}

_PAGE_SIZE = 100


def _normalize_endpoint(url: str) -> str:
    """Ensure the endpoint URL ends with ``/wp-json/`` so path joining works."""
    url = url.rstrip("/")
    if not url.endswith("/wp-json"):
        url += "/wp-json"
    return url + "/"


def _flatten_rendered(record: dict[str, Any]) -> dict[str, Any]:
    """If a field value is a dict with a ``rendered`` key, replace it with that value."""
    out: dict[str, Any] = {}
    for key, value in record.items():
        if isinstance(value, dict) and "rendered" in value:
            out[key] = value["rendered"]
        else:
            out[key] = value
    return out


def _strip_for_create(record: dict[str, Any]) -> dict[str, Any]:
    """Remove ``id`` and ``createdTime`` and flatten rendered objects."""
    cleaned = {k: v for k, v in record.items() if k not in ("id", "createdTime")}
    cleaned.setdefault("status", "publish")
    return _flatten_rendered(cleaned)


def _strip_for_update(record: dict[str, Any]) -> dict[str, Any]:
    """Remove ``id`` (sent in the URL) and ``createdTime``, flatten rendered objects."""
    cleaned = {k: v for k, v in record.items() if k not in ("id", "createdTime")}
    return _flatten_rendered(cleaned)


class WordPress(Connector):
    name = "wordpress"
    display_name = "WordPress"
    fields = [
        Field("endpoint", "WordPress URL", required=True, placeholder="https://your-site.com"),
        Field("username", "Username", required=True),
        Field("password", "Application Password", required=True, secret=True),
    ]

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        username = self.credentials.get("username", "")
        password = self.credentials.get("password", "")
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        return {
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _base_url(self) -> str:
        return _normalize_endpoint(self.credentials.get("endpoint", ""))

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._base_url(),
            headers=self._auth_headers(),
            timeout=30.0,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def test_connection(self) -> None:
        """Validate credentials by fetching a small page of posts."""
        async with self._client() as client:
            resp = await client.get("wp/v2/posts", params={"per_page": 5, "context": "edit"})
            if resp.status_code == 401:
                raise PermissionError("WordPress authentication failed. Check username and application password.")
            resp.raise_for_status()

    async def list_tables(self) -> list[TablePreview]:
        tables: list[TablePreview] = []
        async with self._client() as client:
            # --- Post types ---
            resp = await client.get("wp/v2/types")
            resp.raise_for_status()
            types_data: dict[str, Any] = resp.json()
            for _slug, info in types_data.items():
                rest_base = info.get("rest_base")
                name = info.get("name", _slug)
                slug = info.get("slug", _slug)
                if not rest_base or slug in _EXCLUDED_TYPES:
                    continue
                tables.append(TablePreview(remote_id=[rest_base], name=name))

            # --- Taxonomies ---
            resp = await client.get("wp/v2/taxonomies")
            resp.raise_for_status()
            tax_data: dict[str, Any] = resp.json()
            for _slug, info in tax_data.items():
                rest_base = info.get("rest_base")
                name = info.get("name", _slug)
                if not rest_base:
                    continue
                tables.append(TablePreview(remote_id=[rest_base], name=name))

        return tables

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        resource = table_id[0]
        async with self._client() as client:
            resp = await client.request("OPTIONS", f"wp/v2/{resource}")
            resp.raise_for_status()
            data = resp.json()
            properties = data.get("schema", {}).get("properties", {})
            columns = []
            for name, prop in properties.items():
                columns.append({
                    "name": name,
                    "type": prop.get("type", "string") if isinstance(prop.get("type"), str) else "string",
                    "readonly": prop.get("readonly", False),
                })
            return {"name": resource, "idColumnRemoteId": "id", "columns": columns}

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        resource = table_id[0]
        offset = 0
        async with self._client() as client:
            while True:
                params: dict[str, Any] = {
                    "per_page": _PAGE_SIZE,
                    "offset": offset,
                    "context": "edit",
                }
                # The "media" endpoint does not support status=any
                if resource != "media":
                    params["status"] = "any"

                resp = await client.get(f"wp/v2/{resource}", params=params)
                resp.raise_for_status()
                records: list[dict[str, Any]] = resp.json()

                if records:
                    yield records

                if len(records) < _PAGE_SIZE:
                    break

                offset += _PAGE_SIZE

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        resource = table_id[0]
        created: list[dict] = []
        async with self._client() as client:
            for record in records:
                body = _strip_for_create(record)
                resp = await client.post(f"wp/v2/{resource}", json=body)
                resp.raise_for_status()
                created.append(resp.json())
        return created

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        resource = table_id[0]
        async with self._client() as client:
            for record in records:
                record_id = record["id"]
                body = _strip_for_update(record)
                resp = await client.patch(f"wp/v2/{resource}/{record_id}", json=body)
                resp.raise_for_status()

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        resource = table_id[0]
        async with self._client() as client:
            for rid in record_ids:
                resp = await client.delete(f"wp/v2/{resource}/{rid}", params={"force": "true"})
                resp.raise_for_status()

    def batch_size(self, operation: str = "create") -> int:
        return 25
