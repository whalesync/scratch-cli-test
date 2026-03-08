from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.connectors.base import Connector, Field, TablePreview


class Moco(Connector):
    name = "moco"
    display_name = "Moco CRM"
    auth_type = "API_KEY"
    fields = [
        Field("domain", "Moco Domain", required=True, placeholder="your-company"),
        Field("apiKey", "API Key", required=True, secret=True),
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
