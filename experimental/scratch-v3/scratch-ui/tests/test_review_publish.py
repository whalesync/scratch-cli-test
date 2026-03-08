"""Tests for the publish route in review.py — Rust engine vs fallback."""

import asyncio
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


class TestRunPublishBackground:
    @pytest.mark.asyncio
    async def test_successful_publish_marks_job_completed(self, workbook):
        from app.services import _run_publish

        job = db.create_job("wb-1", "push", state="active")
        git = AsyncMock()

        async def fake_build(wid):
            return {"operations": [{"phase": "edit"}]}

        async def fake_run(plan, wid, g):
            return {"edited": 1, "created": 0, "deleted": 0, "errors": []}

        await _run_publish(job["id"], "wb-1", git, fake_build, fake_run)

        updated = db.get_job(job["id"])
        assert updated["state"] == "completed"

    @pytest.mark.asyncio
    async def test_empty_plan_completes_with_zero(self, workbook):
        from app.services import _run_publish

        job = db.create_job("wb-1", "push", state="active")
        git = AsyncMock()

        async def fake_build(wid):
            return {"operations": []}

        await _run_publish(job["id"], "wb-1", git, fake_build, None)

        updated = db.get_job(job["id"])
        assert updated["state"] == "completed"

    @pytest.mark.asyncio
    async def test_errors_mark_job_failed(self, workbook):
        from app.services import _run_publish

        job = db.create_job("wb-1", "push", state="active")
        git = AsyncMock()

        async def fake_build(wid):
            return {"operations": [{"phase": "edit"}]}

        async def fake_run(plan, wid, g):
            return {"edited": 0, "created": 0, "deleted": 0, "errors": ["something broke"]}

        await _run_publish(job["id"], "wb-1", git, fake_build, fake_run)

        updated = db.get_job(job["id"])
        assert updated["state"] == "failed"

    @pytest.mark.asyncio
    async def test_exception_marks_job_failed(self, workbook):
        from app.services import _run_publish

        job = db.create_job("wb-1", "push", state="active")
        git = AsyncMock()

        async def fake_build(wid):
            raise RuntimeError("Rust panicked")

        await _run_publish(job["id"], "wb-1", git, fake_build, None)

        updated = db.get_job(job["id"])
        assert updated["state"] == "failed"
        result = updated.get("result", {})
        assert "Rust panicked" in str(result)
