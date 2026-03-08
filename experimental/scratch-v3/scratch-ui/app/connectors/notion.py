from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.connectors.base import Connector, Field, OAuthFlow, TablePreview


class Notion(Connector):
    name = "notion"
    display_name = "Notion"
    auth_type = "API_KEY"
    auth = OAuthFlow(
        authorize_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        scopes=[],
    )
    fields = [
        Field("apiKey", "Integration Token", secret=True, placeholder="ntn_..."),
    ]

    async def test_connection(self) -> None:
        raise NotImplementedError

    async def list_tables(self) -> list[TablePreview]:
        raise NotImplementedError

    async def search_tables(self, query: str) -> list[TablePreview]:
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
