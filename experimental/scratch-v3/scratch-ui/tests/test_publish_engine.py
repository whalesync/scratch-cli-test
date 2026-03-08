"""Tests for publish_engine.py — plan building and execution."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.db as db
from tests.conftest import seed_connection, seed_folder, seed_workbook


@pytest.fixture
def workbook():
    wb = seed_workbook()
    seed_connection()
    seed_folder()
    return wb


# ---------------------------------------------------------------------------
# build_plan
# ---------------------------------------------------------------------------


class TestBuildPlan:
    @pytest.mark.asyncio
    async def test_empty_when_no_dirty_files(self, workbook):
        from app.publish_engine import build_plan

        empty_plan = {"operations": []}
        with patch("app.publish_engine.scratch_engine") as mock_engine:
            mock_engine.build_plan_from_git.return_value = json.dumps(empty_plan)
            plan = await build_plan("wb-1")

        assert plan == {"operations": []}
        mock_engine.build_plan_from_git.assert_called_once()

    @pytest.mark.asyncio
    async def test_calls_rust_engine_with_dirty_files(self, workbook):
        from app.publish_engine import build_plan

        fake_plan = {"operations": [{"phase": "edit", "path": "/posts/rec1.json"}]}
        with patch("app.publish_engine.scratch_engine") as mock_engine:
            mock_engine.build_plan_from_git.return_value = json.dumps(fake_plan)
            plan = await build_plan("wb-1")

        assert plan["operations"][0]["phase"] == "edit"
        mock_engine.build_plan_from_git.assert_called_once()

    @pytest.mark.asyncio
    async def test_missing_workbook_raises(self):
        from app.publish_engine import build_plan

        with pytest.raises(ValueError, match="Workbook not found"):
            await build_plan("nonexistent")


# ---------------------------------------------------------------------------
# run_plan
# ---------------------------------------------------------------------------


class TestRunPlan:
    @pytest.mark.asyncio
    async def test_empty_plan(self, mock_git, workbook):
        from app.publish_engine import run_plan

        result = await run_plan({"operations": []}, "wb-1", mock_git)
        assert result["edited"] == 0
        assert result["created"] == 0
        assert result["errors"] == []

    @pytest.mark.asyncio
    async def test_edit_phase_calls_connector(self, mock_git, workbook):
        # Seed file index so remote ID can be found
        db.upsert_file_index("wb-1", "/posts", "rec1.json", "remote-rec1")

        plan = {
            "operations": [
                {
                    "phase": "edit",
                    "path": "/posts/rec1.json",
                    "dataFolderId": "folder-1",
                    "changedFields": {"title": "Updated"},
                },
            ],
        }

        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.update_records.return_value = []

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["edited"] == 1
        mock_connector.update_records.assert_called_once()
        # Verify remote ID was passed
        call_args = mock_connector.update_records.call_args[0]
        records = call_args[1]
        assert records[0]["id"] == "remote-rec1"

    @pytest.mark.asyncio
    async def test_edit_missing_remote_id_reports_error(self, mock_git, workbook):
        plan = {
            "operations": [
                {
                    "phase": "edit",
                    "path": "/posts/no-index.json",
                    "dataFolderId": "folder-1",
                    "changedFields": {"title": "Updated"},
                },
            ],
        }

        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["edited"] == 0
        assert any("No remote ID" in e for e in result["errors"])

    @pytest.mark.asyncio
    async def test_create_phase(self, mock_git, workbook):
        plan = {
            "operations": [
                {
                    "phase": "create",
                    "path": "/posts/spub_abc.json",
                    "dataFolderId": "folder-1",
                    "content": {"id": "spub_abc", "title": "New Post"},
                },
            ],
        }

        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.create_records.return_value = [{"id": "real-id-123", "title": "New Post"}]

        mock_git.read_file.return_value = {"content": '{"id": "spub_abc", "title": "New Post"}'}

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["created"] == 1
        # Verify file index was updated with real ID
        record_id = db.get_record_id("wb-1", "/posts", "spub_abc.json")
        assert record_id == "real-id-123"

    @pytest.mark.asyncio
    async def test_delete_phase(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "rec-del.json", "remote-del")

        plan = {
            "operations": [
                {
                    "phase": "delete",
                    "path": "/posts/rec-del.json",
                    "dataFolderId": "folder-1",
                },
            ],
        }

        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.delete_records.return_value = []

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["deleted"] == 1
        mock_connector.delete_records.assert_called_once()
        # Verify file index was cleaned up
        assert db.get_record_id("wb-1", "/posts", "rec-del.json") is None

    @pytest.mark.asyncio
    async def test_rename_phase(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "spub_temp.json", "real-id-456")

        plan = {
            "operations": [
                {
                    "phase": "rename-files",
                    "path": "/posts/spub_temp.json",
                    "dataFolderId": "folder-1",
                },
            ],
        }

        from app.publish_engine import run_plan

        result = await run_plan(plan, "wb-1", mock_git)

        assert result["renamed"] == 1
        mock_git.rename_files.assert_called_once()
        rename_args = mock_git.rename_files.call_args[0]
        renames = rename_args[2]
        assert renames[0]["oldName"] == "spub_temp.json"
        assert renames[0]["newName"] == "real-id-456.json"

    @pytest.mark.asyncio
    async def test_phase_order(self, mock_git, workbook):
        """Phases execute in order: edit, create, delete, backfill, rename-files."""
        db.upsert_file_index("wb-1", "/posts", "edit-me.json", "remote-edit")
        db.upsert_file_index("wb-1", "/posts", "delete-me.json", "remote-del")

        plan = {
            "operations": [
                {"phase": "delete", "path": "/posts/delete-me.json", "dataFolderId": "folder-1"},
                {"phase": "edit", "path": "/posts/edit-me.json", "dataFolderId": "folder-1", "changedFields": {"x": 1}},
            ],
        }

        call_order = []
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)

        async def track_update(*a, **kw):
            call_order.append("edit")
            return []

        async def track_delete(*a, **kw):
            call_order.append("delete")
            return []

        mock_connector.update_records.side_effect = track_update
        mock_connector.delete_records.side_effect = track_delete

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            await run_plan(plan, "wb-1", mock_git)

        assert call_order == ["edit", "delete"]

    @pytest.mark.asyncio
    async def test_missing_folder_reports_error(self, mock_git, workbook):
        plan = {
            "operations": [
                {"phase": "edit", "path": "/nope/x.json", "dataFolderId": "nonexistent"},
            ],
        }

        from app.publish_engine import run_plan

        result = await run_plan(plan, "wb-1", mock_git)
        assert any("not found" in e for e in result["errors"])


# ---------------------------------------------------------------------------
# Bug-finding tests
#
# Each test below asserts CORRECT behavior. A failing test = a real bug.
# ---------------------------------------------------------------------------


class TestEditBatchFailureDesync:
    """_run_edits publishes files to git and inflates edited count even when
    connector.update_records fails. This desyncs git main from the remote."""

    @pytest.mark.asyncio
    async def test_failed_update_should_not_count_as_edited(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "rec1.json", "remote-1")
        plan = {
            "operations": [{
                "phase": "edit",
                "path": "/posts/rec1.json",
                "dataFolderId": "folder-1",
                "changedFields": {"title": "Updated"},
            }],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.update_records.side_effect = RuntimeError("API 500")

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert any("API 500" in e for e in result["errors"])
        # BUG: returns 1 — the count includes records whose remote update failed
        assert result["edited"] == 0

    @pytest.mark.asyncio
    async def test_failed_update_should_not_publish_to_git(self, mock_git, workbook):
        """If the remote wasn't updated, publishing the file to git main
        creates a silent desync — git thinks it's published, remote disagrees."""
        db.upsert_file_index("wb-1", "/posts", "rec1.json", "remote-1")
        plan = {
            "operations": [{
                "phase": "edit",
                "path": "/posts/rec1.json",
                "dataFolderId": "folder-1",
                "changedFields": {"title": "Updated"},
            }],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.update_records.side_effect = RuntimeError("API 500")

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            await run_plan(plan, "wb-1", mock_git)

        # BUG: publish IS called — file moves to git main despite remote failure
        mock_git.publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_partial_batch_failure_overcounts_and_publishes_all(self, mock_git, workbook):
        """With batch_size=1, first update succeeds, second fails.
        Only the successful record should be counted and published."""
        db.upsert_file_index("wb-1", "/posts", "a.json", "remote-a")
        db.upsert_file_index("wb-1", "/posts", "b.json", "remote-b")
        plan = {
            "operations": [
                {"phase": "edit", "path": "/posts/a.json", "dataFolderId": "folder-1", "changedFields": {"x": 1}},
                {"phase": "edit", "path": "/posts/b.json", "dataFolderId": "folder-1", "changedFields": {"x": 2}},
            ],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=1)

        call_count = 0

        async def fail_second(table_id, records):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("batch 2 failed")
            return []

        mock_connector.update_records.side_effect = fail_second

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        # BUG: edited is 2 (all paths) instead of 1 (only the successful batch)
        assert result["edited"] == 1


class TestDeleteBatchFailureDataLoss:
    """_run_deletes discards git changes and removes file_index for ALL records
    unconditionally — even records whose remote delete failed. The mapping is
    lost and the delete cannot be retried. This is unrecoverable data loss."""

    @pytest.mark.asyncio
    async def test_failed_delete_should_preserve_file_index(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "a.json", "remote-a")
        db.upsert_file_index("wb-1", "/posts", "b.json", "remote-b")
        plan = {
            "operations": [
                {"phase": "delete", "path": "/posts/a.json", "dataFolderId": "folder-1"},
                {"phase": "delete", "path": "/posts/b.json", "dataFolderId": "folder-1"},
            ],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=1)

        call_count = 0

        async def fail_second(table_id, ids):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("API 500")
            return []

        mock_connector.delete_records.side_effect = fail_second

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["deleted"] == 1
        assert len(result["errors"]) == 1
        # First record correctly cleaned up
        assert db.get_record_id("wb-1", "/posts", "a.json") is None
        # BUG: file_index for b is gone even though its remote delete failed
        # The record still exists remotely but we've lost the mapping
        assert db.get_record_id("wb-1", "/posts", "b.json") is not None

    @pytest.mark.asyncio
    async def test_failed_delete_should_not_discard_git_changes(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "a.json", "remote-a")
        db.upsert_file_index("wb-1", "/posts", "b.json", "remote-b")
        plan = {
            "operations": [
                {"phase": "delete", "path": "/posts/a.json", "dataFolderId": "folder-1"},
                {"phase": "delete", "path": "/posts/b.json", "dataFolderId": "folder-1"},
            ],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=1)

        call_count = 0

        async def fail_second(table_id, ids):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("API 500")
            return []

        mock_connector.delete_records.side_effect = fail_second

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            await run_plan(plan, "wb-1", mock_git)

        # BUG: discard_changes called for both paths — b.json's git state is
        # wiped even though the record still exists in the remote service
        discard_calls = mock_git.discard_changes.call_args_list
        discarded_paths = [c[0][1] for c in discard_calls]
        assert "/posts/b.json" not in discarded_paths


class TestCreateFailureOrphan:
    """_run_creates publishes ALL files to git main regardless of which
    create batches failed. Failed creates become orphaned in git — the file
    exists on main but has no remote record, and won't show as dirty on
    next review."""

    @pytest.mark.asyncio
    async def test_failed_create_should_not_publish_to_git(self, mock_git, workbook):
        plan = {
            "operations": [{
                "phase": "create",
                "path": "/posts/spub_abc.json",
                "dataFolderId": "folder-1",
                "content": {"id": "spub_abc", "title": "New"},
            }],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.create_records.side_effect = RuntimeError("API 500")

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            result = await run_plan(plan, "wb-1", mock_git)

        assert result["created"] == 0
        assert len(result["errors"]) == 1
        # BUG: publish IS called — file orphaned in git main with no remote record
        mock_git.publish.assert_not_called()


class TestCreateNoneId:
    """When connector returns {id: None}, str(None) produces the string
    'None' which passes the truthiness check and is stored as a record_id.
    Subsequent operations send 'None' as the remote ID to the connector."""

    @pytest.mark.asyncio
    async def test_none_id_should_not_be_stored(self, mock_git, workbook):
        plan = {
            "operations": [{
                "phase": "create",
                "path": "/posts/spub_xyz.json",
                "dataFolderId": "folder-1",
                "content": {"id": "spub_xyz", "title": "Test"},
            }],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.create_records.return_value = [{"id": None, "title": "Test"}]

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            await run_plan(plan, "wb-1", mock_git)

        # BUG: record_id is the string "None" instead of being skipped
        record_id = db.get_record_id("wb-1", "/posts", "spub_xyz.json")
        assert record_id is None


class TestChangedFieldsFalsy:
    """Line 235: `op.get("changedFields") or op.get("content", {})`
    Empty dict {} is falsy in Python, so changedFields={} silently falls
    through to sending full content — causing unintended field overwrites."""

    @pytest.mark.asyncio
    async def test_empty_changed_fields_should_not_send_content(self, mock_git, workbook):
        db.upsert_file_index("wb-1", "/posts", "rec1.json", "remote-1")
        plan = {
            "operations": [{
                "phase": "edit",
                "path": "/posts/rec1.json",
                "dataFolderId": "folder-1",
                "changedFields": {},
                "content": {"title": "Full", "body": "Should NOT be sent"},
            }],
        }
        mock_connector = AsyncMock()
        mock_connector.batch_size = MagicMock(return_value=10)
        mock_connector.update_records.return_value = []

        from app.publish_engine import run_plan

        with patch("app.publish_engine.get_connector", AsyncMock(return_value=mock_connector)):
            await run_plan(plan, "wb-1", mock_git)

        # changedFields={} means no fields changed — should skip the API call,
        # NOT fall through to sending full content
        mock_connector.update_records.assert_not_called()
