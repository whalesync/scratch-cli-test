"""Supabase connector — async PostgreSQL via asyncpg with schema-aware operations."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

import asyncpg

from app.connectors.base import Connector, Field, OAuthFlow, TablePreview

# Schemas that Supabase uses internally and should never be exposed to users.
_SYSTEM_SCHEMAS: set[str] = {
    "pg_catalog",
    "information_schema",
    "pg_toast",
    "pg_temp",
    "extensions",
    "graphql",
    "graphql_public",
    "realtime",
    "storage",
    "supabase_functions",
    "supabase_migrations",
    "auth",
    "vault",
    "pgsodium",
    "pgsodium_masks",
    "_analytics",
    "_realtime",
    "pgbouncer",
    "_supavisor",
}

# Postgres identifiers: letters, digits, underscores, up to 63 chars.
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")

_PULL_BATCH_SIZE = 500


def _validate_identifier(name: str) -> str:
    """Raise ValueError if *name* is not a safe SQL identifier."""
    if not _IDENT_RE.match(name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


def _qualified_table(schema: str, table: str) -> str:
    """Return a fully-quoted ``"schema"."table"`` string."""
    return f'"{_validate_identifier(schema)}"."{_validate_identifier(table)}"'


class Supabase(Connector):
    name = "supabase"
    display_name = "Supabase"
    auth = OAuthFlow(
        authorize_url="https://api.supabase.com/v1/oauth/authorize",
        token_url="https://api.supabase.com/v1/oauth/token",
        scopes=[],
    )
    fields = [
        Field(
            "connectionString",
            "Connection String (Transaction pooler)",
            required=True,
            secret=True,
            placeholder="postgresql://postgres.xxx:pass@aws-0-region.pooler.supabase.com:6543/postgres",
        ),
    ]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @property
    def _dsn(self) -> str:
        dsn = self.credentials.get("connectionString", "")
        if not dsn:
            raise ValueError("Missing connectionString credential")
        return dsn

    async def _connect(self) -> asyncpg.Connection:
        return await asyncpg.connect(self._dsn, ssl="prefer")

    async def _get_primary_key(self, conn: asyncpg.Connection, schema: str, table: str) -> str:
        """Return the first primary-key column for *schema*.*table*, or raise."""
        row = await conn.fetchrow(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1
              AND tc.table_name = $2
            LIMIT 1
            """,
            schema,
            table,
        )
        if row is None:
            raise ValueError(f"Table {schema}.{table} has no primary key")
        return row["column_name"]

    async def _get_valid_columns(self, conn: asyncpg.Connection, schema: str, table: str) -> set[str]:
        """Return the set of column names that actually exist on the table."""
        rows = await conn.fetch(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            """,
            schema,
            table,
        )
        return {r["column_name"] for r in rows}

    @staticmethod
    def _parse_table_id(table_id: list[str]) -> tuple[str, str]:
        if len(table_id) != 2:
            raise ValueError(f"table_id must be [schema, table_name], got {table_id!r}")
        return table_id[0], table_id[1]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def test_connection(self) -> None:
        conn = await self._connect()
        try:
            await conn.fetchval("SELECT 1")
        finally:
            await conn.close()

    async def list_tables(self) -> list[TablePreview]:
        conn = await self._connect()
        try:
            # Build the IN-list as a parameterised array comparison.
            rows = await conn.fetch(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema != ALL($1::text[])
                  AND table_schema NOT LIKE 'pg_toast_temp_%'
                  AND table_schema NOT LIKE 'pg_temp_%'
                ORDER BY table_schema, table_name
                """,
                list(_SYSTEM_SCHEMAS),
            )
            results: list[TablePreview] = []
            for r in rows:
                schema = r["table_schema"]
                table = r["table_name"]
                display = table if schema == "public" else f"{schema}.{table}"
                results.append(TablePreview(remote_id=[schema, table], name=display))
            return results
        finally:
            await conn.close()

    async def fetch_schema(self, table_id: list[str]) -> dict | None:
        schema_name, table_name = self._parse_table_id(table_id)
        _TYPE_MAP = {
            "integer": "number", "bigint": "number", "smallint": "number",
            "numeric": "number", "real": "number", "double precision": "number",
            "serial": "number", "bigserial": "number",
            "boolean": "boolean",
            "timestamp with time zone": "date", "timestamp without time zone": "date",
            "date": "date", "time with time zone": "date", "time without time zone": "date",
            "json": "object", "jsonb": "object", "uuid": "string",
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
            pk = await self._get_primary_key(conn, schema_name, table_name)
            columns = []
            for r in rows:
                default = r["column_default"] or ""
                columns.append({
                    "name": r["column_name"],
                    "type": _TYPE_MAP.get(r["data_type"], "string"),
                    "readonly": default.startswith("nextval(") or "gen_random_uuid" in default,
                    "nativeType": r["data_type"],
                    "nullable": r["is_nullable"] == "YES",
                })
            return {"name": table_name, "idColumnRemoteId": pk, "columns": columns}
        finally:
            await conn.close()

    async def pull_records(self, table_id: list[str]) -> AsyncIterator[list[dict[str, Any]]]:
        schema, table = self._parse_table_id(table_id)
        qualified = _qualified_table(schema, table)

        conn = await self._connect()
        try:
            pk = await self._get_primary_key(conn, schema, table)
            _validate_identifier(pk)
            quoted_pk = f'"{pk}"'

            offset = 0
            while True:
                rows = await conn.fetch(
                    f"SELECT * FROM {qualified} ORDER BY {quoted_pk} LIMIT $1 OFFSET $2",
                    _PULL_BATCH_SIZE,
                    offset,
                )
                if not rows:
                    break
                yield [dict(r) for r in rows]
                if len(rows) < _PULL_BATCH_SIZE:
                    break
                offset += _PULL_BATCH_SIZE
        finally:
            await conn.close()

    async def create_records(self, table_id: list[str], records: list[dict]) -> list[dict]:
        if not records:
            return []

        schema, table = self._parse_table_id(table_id)
        qualified = _qualified_table(schema, table)

        conn = await self._connect()
        try:
            valid_columns = await self._get_valid_columns(conn, schema, table)

            created: list[dict] = []
            for record in records:
                cols = [c for c in record if c in valid_columns]
                if not cols:
                    continue
                for c in cols:
                    _validate_identifier(c)

                col_list = ", ".join(f'"{c}"' for c in cols)
                param_list = ", ".join(f"${i + 1}" for i in range(len(cols)))
                values = [record[c] for c in cols]

                row = await conn.fetchrow(
                    f"INSERT INTO {qualified} ({col_list}) VALUES ({param_list}) RETURNING *",
                    *values,
                )
                if row is not None:
                    created.append(dict(row))
            return created
        finally:
            await conn.close()

    async def update_records(self, table_id: list[str], records: list[dict]) -> None:
        if not records:
            return

        schema, table = self._parse_table_id(table_id)
        qualified = _qualified_table(schema, table)

        conn = await self._connect()
        try:
            pk = await self._get_primary_key(conn, schema, table)
            _validate_identifier(pk)
            valid_columns = await self._get_valid_columns(conn, schema, table)

            for record in records:
                if pk not in record:
                    raise ValueError(f"Record missing primary key column '{pk}'")
                pk_value = record[pk]
                cols = [c for c in record if c in valid_columns and c != pk]
                if not cols:
                    continue
                for c in cols:
                    _validate_identifier(c)

                set_clause = ", ".join(f'"{c}" = ${i + 1}' for i, c in enumerate(cols))
                pk_param = f"${len(cols) + 1}"
                values = [record[c] for c in cols] + [pk_value]

                await conn.execute(
                    f'UPDATE {qualified} SET {set_clause} WHERE "{pk}" = {pk_param}',
                    *values,
                )
        finally:
            await conn.close()

    async def delete_records(self, table_id: list[str], record_ids: list[str]) -> None:
        if not record_ids:
            return

        schema, table = self._parse_table_id(table_id)
        qualified = _qualified_table(schema, table)

        conn = await self._connect()
        try:
            pk = await self._get_primary_key(conn, schema, table)
            _validate_identifier(pk)

            for rid in record_ids:
                await conn.execute(
                    f'DELETE FROM {qualified} WHERE "{pk}" = $1',
                    rid,
                )
        finally:
            await conn.close()

    def batch_size(self, operation: str = "create") -> int:
        return 100
