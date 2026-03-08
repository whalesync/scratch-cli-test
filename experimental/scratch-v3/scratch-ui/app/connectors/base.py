"""Base connector class. Each connector is a single .py file in this directory."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass
class OAuthFlow:
    authorize_url: str
    token_url: str
    scopes: list[str] = field(default_factory=list)


@dataclass
class Field:
    name: str
    label: str
    required: bool = False
    secret: bool = False
    placeholder: str = ""


@dataclass
class TablePreview:
    remote_id: list[str]
    name: str
    ws_id: str = ""


class Connector(ABC):
    """Drop a subclass in app/connectors/<name>.py — it's auto-discovered.

    Phase 1 (now): Declarative metadata only. Business logic proxies through NestJS.
    Phase 2 (later): Implement pull/push/discover directly against external APIs.
    """

    # -- Required class attributes (set these, don't make them methods) --

    name: str  # unique key, e.g. "airtable"
    display_name: str  # human label, e.g. "Airtable"
    auth_type: str = "USER_PROVIDED_PARAMS"  # API_KEY, USER_PROVIDED_PARAMS, or OAUTH
    fields: list[Field] = []
    auth: OAuthFlow | None = None
    oauth_only: bool = False

    # -- Lifecycle --

    def __init__(self, credentials: dict[str, str] | None = None):
        self.credentials = credentials or {}

    # -- Discovery --

    @abstractmethod
    async def test_connection(self) -> None:
        """Validate credentials. Raise on failure, return silently on success."""

    @abstractmethod
    async def list_tables(self) -> list[TablePreview]:
        """Return available tables/collections from the remote service."""

    # -- Pull --

    @abstractmethod
    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        """Yield batches of records from the remote service."""

    # -- Push --

    @abstractmethod
    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        """Create records, return them with remote IDs assigned."""

    @abstractmethod
    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        """Update existing records."""

    @abstractmethod
    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        """Delete records by remote ID."""

    # -- Schema --

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        """Fetch table schema from the service's metadata API.

        Returns {name, idColumnRemoteId, columns: [{name, type, readonly, ...}]}
        or None if the connector doesn't support metadata introspection.
        """
        return None

    # -- Optional overrides --

    def batch_size(self, operation: str = "create") -> int:
        """Max records per API call. Override per connector."""
        return 10

    async def search_tables(self, query: str) -> list[TablePreview]:
        """Search tables instead of listing (for services with many tables)."""
        raise NotImplementedError
