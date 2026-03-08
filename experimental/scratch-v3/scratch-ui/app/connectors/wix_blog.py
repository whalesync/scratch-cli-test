from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.connectors.base import Connector, OAuthFlow, TablePreview


class WixBlog(Connector):
    name = "wix_blog"
    display_name = "Wix Blog"
    oauth_only = True
    auth = OAuthFlow(
        authorize_url="https://www.wix.com/installer/install",
        token_url="https://www.wixapis.com/oauth/access",
        scopes=["site.blog"],
    )

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
