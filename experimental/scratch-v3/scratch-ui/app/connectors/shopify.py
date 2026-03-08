from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.connectors.base import Connector, Field, OAuthFlow, TablePreview


class Shopify(Connector):
    name = "shopify"
    display_name = "Shopify"
    auth_type = "API_KEY"
    auth = OAuthFlow(
        authorize_url="https://{shop}.myshopify.com/admin/oauth/authorize",
        token_url="https://{shop}.myshopify.com/admin/oauth/access_token",
        scopes=["read_products", "write_products"],
    )
    fields = [
        Field("shopDomain", "Shop Domain", required=True, placeholder="your-store.myshopify.com"),
        Field("apiKey", "Admin API Access Token", secret=True),
    ]

    async def test_connection(self) -> None:
        raise NotImplementedError

    async def list_tables(self) -> list[TablePreview]:
        raise NotImplementedError

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        raise NotImplementedError
        yield

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        raise NotImplementedError

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        raise NotImplementedError

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        raise NotImplementedError
