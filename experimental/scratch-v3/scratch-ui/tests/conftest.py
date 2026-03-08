"""Shared fixtures for unit tests."""

import sqlite3
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock

import pytest

# Provide a stub scratch_engine before any app code tries to import it
if "scratch_engine" not in sys.modules:
    stub = ModuleType("scratch_engine")
    stub.build_publish_plan = MagicMock(return_value="{}")
    stub.sync_table_mapping = MagicMock(return_value="{}")
    stub.validate_record = MagicMock(return_value="[]")
    stub.transform_record = MagicMock(return_value="{}")
    stub.compute_changed_fields = MagicMock(return_value="{}")
    sys.modules["scratch_engine"] = stub


# Point DB at a temp file before importing app modules
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()

# Pre-import _helpers to avoid app.routes auto-discovery circular import
import app.routes._helpers  # noqa: E402

import app.db as db  # noqa: E402

db.DB_PATH = Path(_tmp.name)


@pytest.fixture(autouse=True)
def fresh_db():
    """Reset the database before each test."""
    conn = sqlite3.connect(str(db.DB_PATH))
    conn.executescript(db.SCHEMA)
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    for (table,) in cursor.fetchall():
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()
    yield


@pytest.fixture
def mock_git():
    """A GitClient mock with async methods."""
    git = AsyncMock()
    git.git_status.return_value = []
    git.read_file.return_value = {"content": "{}"}
    git.read_files_batch.return_value = []
    git.write_files.return_value = {}
    git.list_files.return_value = []
    git.publish.return_value = {}
    git.discard_changes.return_value = {}
    git.rename_files.return_value = {}
    return git


def seed_workbook(workbook_id="wb-1", name="Test Workbook"):
    """Insert a workbook directly and return it."""
    conn = db.get_db()
    conn.execute(
        "INSERT OR REPLACE INTO workbook (id, name, organization_id, user_id) VALUES (?, ?, ?, ?)",
        (workbook_id, name, "org-1", "user-1"),
    )
    conn.commit()
    conn.close()
    return db.get_workbook(workbook_id)


def seed_connection(connector_id="conn-1", workbook_id="wb-1", service="AIRTABLE"):
    conn = db.get_db()
    conn.execute(
        "INSERT OR REPLACE INTO connector_account (id, workbook_id, service, display_name, encrypted_credentials)"
        " VALUES (?, ?, ?, ?, ?)",
        (connector_id, workbook_id, service, f"Test {service}", "{}"),
    )
    conn.commit()
    conn.close()


def seed_folder(
    workbook_id="wb-1",
    folder_id="folder-1",
    name="Posts",
    path="/posts",
    service="AIRTABLE",
    connector_id="conn-1",
    table_id="tbl123",
):
    """Insert a data folder directly."""
    conn = db.get_db()
    conn.execute(
        "INSERT OR REPLACE INTO data_folder"
        " (id, workbook_id, connector_account_id, connector_service, connector_display_name, name, path, table_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (folder_id, workbook_id, connector_id, service, f"Test {service}", name, path, table_id),
    )
    conn.commit()
    conn.close()
