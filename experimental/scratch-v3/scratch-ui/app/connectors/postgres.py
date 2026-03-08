from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import asyncpg

from app.connectors.base import Connector, Field, TablePreview

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PULL_BATCH_SIZE = 500
CONNECT_TIMEOUT = 10
STATEMENT_TIMEOUT_MS = 30_000


def _quote(identifier: str) -> str:
    """Double-quote a SQL identifier, escaping any embedded double-quotes."""
    return '"' + identifier.replace('"', '""') + '"'


def _parse_table_id(table_id: list[str]) -> tuple[str, str]:
    """Return (schema, table_name) from a table_id list."""
    if len(table_id) >= 2:
        return table_id[0], table_id[1]
    return "public", table_id[0]


# ---------------------------------------------------------------------------
# Connector
# ---------------------------------------------------------------------------


class Postgres(Connector):
    name = "postgres"
    display_name = "PostgreSQL"
    fields = [
        Field(
            "connectionString",
            "Connection String",
            required=True,
            secret=True,
            placeholder="postgresql://user:pass@host:5432/db",
        ),
    ]

    def __init__(self, credentials: dict[str, str] | None = None):
        super().__init__(credentials)
        # Caches — populated lazily, cleared when the connector instance is discarded.
        self._valid_tables: set[str] | None = None
        self._primary_keys: dict[str, str] = {}
        self._table_columns: dict[str, set[str]] = {}

    # -- Internal helpers ---------------------------------------------------

    @property
    def _dsn(self) -> str:
        return self.credentials.get("connectionString", "")

    async def _connect(self) -> asyncpg.Connection:
        conn = await asyncpg.connect(
            self._dsn,
            timeout=CONNECT_TIMEOUT,
            server_settings={"statement_timeout": str(STATEMENT_TIMEOUT_MS)},
        )
        return conn

    async def _ensure_valid_tables(self, conn: asyncpg.Connection) -> set[str]:
        """Load and cache the set of public-schema base-table names."""
        if self._valid_tables is None:
            rows = await conn.fetch(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                "ORDER BY table_name"
            )
            self._valid_tables = {r["table_name"] for r in rows}
        return self._valid_tables

    async def _validate_table(self, conn: asyncpg.Connection, schema: str, table_name: str) -> None:
        """Raise if the table doesn't exist in the cached set (public schema only)."""
        valid = await self._ensure_valid_tables(conn)
        if table_name not in valid:
            raise ValueError(f"Table {schema}.{table_name} does not exist or is not a base table in the public schema")

    async def _get_primary_key(self, conn: asyncpg.Connection, table_name: str) -> str:
        """Return the primary-key column name for *table_name*, falling back to 'id'."""
        if table_name in self._primary_keys:
            return self._primary_keys[table_name]

        row = await conn.fetchrow(
            "SELECT kcu.column_name "
            "FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "WHERE tc.constraint_type = 'PRIMARY KEY' "
            "  AND tc.table_schema = 'public' "
            "  AND tc.table_name = $1 "
            "LIMIT 1",
            table_name,
        )
        pk = row["column_name"] if row else "id"
        self._primary_keys[table_name] = pk
        return pk

    async def _get_table_columns(self, conn: asyncpg.Connection, table_name: str) -> set[str]:
        """Return the set of column names for *table_name* in the public schema."""
        if table_name in self._table_columns:
            return self._table_columns[table_name]

        rows = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = $1",
            table_name,
        )
        cols = {r["column_name"] for r in rows}
        self._table_columns[table_name] = cols
        return cols

    @staticmethod
    def _record_to_dict(record: asyncpg.Record) -> dict[str, Any]:
        return dict(record)

    # -- Public API ---------------------------------------------------------

    def batch_size(self, operation: str = "create") -> int:
        return 100

    async def test_connection(self) -> None:
        conn = await self._connect()
        try:
            await conn.execute("SELECT 1")
        finally:
            await conn.close()

    async def list_tables(self) -> list[TablePreview]:
        conn = await self._connect()
        try:
            rows = await conn.fetch(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                "ORDER BY table_name"
            )
            # Also seed the cache while we're at it.
            self._valid_tables = {r["table_name"] for r in rows}
            return [TablePreview(remote_id=["public", r["table_name"]], name=r["table_name"]) for r in rows]
        finally:
            await conn.close()

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        schema_name, table_name = _parse_table_id(table_id)
        _TYPE_MAP = {
            "integer": "number", "bigint": "number", "smallint": "number",
            "numeric": "number", "real": "number", "double precision": "number",
            "serial": "number", "bigserial": "number",
            "boolean": "boolean",
            "timestamp with time zone": "date", "timestamp without time zone": "date",
            "date": "date", "time with time zone": "date", "time without time zone": "date",
            "json": "object", "jsonb": "object",
            "ARRAY": "array",
        }
        conn = await self._connect()
        try:
            rows = await conn.fetch(
                "SELECT column_name, data_type, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_schema = $1 AND table_name = $2 "
                "ORDER BY ordinal_position",
                schema_name, table_name,
            )
            pk = await self._get_primary_key(conn, table_name)
            columns = []
            for r in rows:
                default = r["column_default"] or ""
                columns.append({
                    "name": r["column_name"],
                    "type": _TYPE_MAP.get(r["data_type"], "string"),
                    "readonly": default.startswith("nextval("),
                    "nativeType": r["data_type"],
                    "nullable": r["is_nullable"] == "YES",
                })
            return {"name": table_name, "idColumnRemoteId": pk, "columns": columns}
        finally:
            await conn.close()

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        schema, table_name = _parse_table_id(table_id)
        conn = await self._connect()
        try:
            await self._validate_table(conn, schema, table_name)
            qualified = f"{_quote(schema)}.{_quote(table_name)}"
            offset = 0
            while True:
                rows = await conn.fetch(
                    f"SELECT * FROM {qualified} LIMIT $1 OFFSET $2",
                    PULL_BATCH_SIZE,
                    offset,
                )
                if not rows:
                    break
                yield [self._record_to_dict(r) for r in rows]
                if len(rows) < PULL_BATCH_SIZE:
                    break
                offset += PULL_BATCH_SIZE
        finally:
            await conn.close()

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        if not records:
            return []

        schema, table_name = _parse_table_id(table_id)
        conn = await self._connect()
        try:
            await self._validate_table(conn, schema, table_name)
            valid_columns = await self._get_table_columns(conn, table_name)
            qualified = f"{_quote(schema)}.{_quote(table_name)}"

            created: list[dict] = []
            for record in records:
                # Filter to only valid columns
                filtered = {k: v for k, v in record.items() if k in valid_columns}
                if not filtered:
                    continue

                columns = list(filtered.keys())
                values = [filtered[c] for c in columns]
                col_list = ", ".join(_quote(c) for c in columns)
                param_list = ", ".join(f"${i}" for i in range(1, len(columns) + 1))

                row = await conn.fetchrow(
                    f"INSERT INTO {qualified} ({col_list}) VALUES ({param_list}) RETURNING *",
                    *values,
                )
                if row:
                    created.append(self._record_to_dict(row))

            return created
        finally:
            await conn.close()

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        if not records:
            return

        schema, table_name = _parse_table_id(table_id)
        conn = await self._connect()
        try:
            await self._validate_table(conn, schema, table_name)
            valid_columns = await self._get_table_columns(conn, table_name)
            pk = await self._get_primary_key(conn, table_name)
            qualified = f"{_quote(schema)}.{_quote(table_name)}"

            for record in records:
                if pk not in record:
                    continue

                pk_value = record[pk]
                # Filter to valid columns, exclude the PK from SET clause
                filtered = {k: v for k, v in record.items() if k in valid_columns and k != pk}
                if not filtered:
                    continue

                columns = list(filtered.keys())
                # $1 is reserved for the PK value in the WHERE clause
                set_clause = ", ".join(f"{_quote(c)} = ${i}" for i, c in enumerate(columns, start=2))
                values = [pk_value] + [filtered[c] for c in columns]

                await conn.execute(
                    f"UPDATE {qualified} SET {set_clause} WHERE {_quote(pk)} = $1",
                    *values,
                )
        finally:
            await conn.close()

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        if not record_ids:
            return

        schema, table_name = _parse_table_id(table_id)
        conn = await self._connect()
        try:
            await self._validate_table(conn, schema, table_name)
            pk = await self._get_primary_key(conn, table_name)
            qualified = f"{_quote(schema)}.{_quote(table_name)}"

            for rid in record_ids:
                await conn.execute(
                    f"DELETE FROM {qualified} WHERE {_quote(pk)} = $1",
                    rid,
                )
        finally:
            await conn.close()
