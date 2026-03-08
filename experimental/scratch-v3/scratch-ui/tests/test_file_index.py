"""Tests for db.py file_index functions."""

import app.db as db


class TestUpsertFileIndex:
    def test_insert_and_retrieve(self):
        db.upsert_file_index("wb-1", "/posts", "rec123.json", "rec123")
        result = db.get_record_id("wb-1", "/posts", "rec123.json")
        assert result == "rec123"

    def test_upsert_updates_filename(self):
        db.upsert_file_index("wb-1", "/posts", "old-name.json", "rec123")
        db.upsert_file_index("wb-1", "/posts", "new-name.json", "rec123")
        # Old filename should no longer resolve
        assert db.get_record_id("wb-1", "/posts", "old-name.json") is None
        # New filename should resolve
        assert db.get_record_id("wb-1", "/posts", "new-name.json") == "rec123"

    def test_different_folders_independent(self):
        db.upsert_file_index("wb-1", "/posts", "rec1.json", "rec1")
        db.upsert_file_index("wb-1", "/pages", "rec1.json", "rec1-pages")
        assert db.get_record_id("wb-1", "/posts", "rec1.json") == "rec1"
        assert db.get_record_id("wb-1", "/pages", "rec1.json") == "rec1-pages"


class TestUpsertFileIndexBatch:
    def test_batch_insert(self):
        entries = [
            {"workbook_id": "wb-1", "folder_path": "/posts", "filename": "a.json", "record_id": "a"},
            {"workbook_id": "wb-1", "folder_path": "/posts", "filename": "b.json", "record_id": "b"},
            {"workbook_id": "wb-1", "folder_path": "/posts", "filename": "c.json", "record_id": "c"},
        ]
        db.upsert_file_index_batch(entries)
        assert db.get_record_id("wb-1", "/posts", "a.json") == "a"
        assert db.get_record_id("wb-1", "/posts", "b.json") == "b"
        assert db.get_record_id("wb-1", "/posts", "c.json") == "c"

    def test_batch_empty(self):
        db.upsert_file_index_batch([])  # Should not raise

    def test_batch_upsert_updates(self):
        db.upsert_file_index("wb-1", "/posts", "old.json", "rec1")
        db.upsert_file_index_batch([
            {"workbook_id": "wb-1", "folder_path": "/posts", "filename": "new.json", "record_id": "rec1"},
        ])
        assert db.get_record_id("wb-1", "/posts", "new.json") == "rec1"
        assert db.get_record_id("wb-1", "/posts", "old.json") is None


class TestGetFileIndexAll:
    def test_returns_all_entries(self):
        db.upsert_file_index_batch([
            {"workbook_id": "wb-1", "folder_path": "/posts", "filename": "a.json", "record_id": "rec-a"},
            {"workbook_id": "wb-1", "folder_path": "/pages", "filename": "b.json", "record_id": "rec-b"},
        ])
        result = db.get_file_index_all("wb-1")
        assert result["/posts/a.json"] == "rec-a"
        assert result["/pages/b.json"] == "rec-b"

    def test_empty_workbook(self):
        assert db.get_file_index_all("wb-nonexistent") == {}

    def test_scoped_to_workbook(self):
        db.upsert_file_index("wb-1", "/posts", "a.json", "rec-a")
        db.upsert_file_index("wb-2", "/posts", "b.json", "rec-b")
        result = db.get_file_index_all("wb-1")
        assert len(result) == 1
        assert "/posts/a.json" in result


class TestDeleteFileIndex:
    def test_delete_removes_entry(self):
        db.upsert_file_index("wb-1", "/posts", "a.json", "rec-a")
        db.delete_file_index("wb-1", "/posts", "rec-a")
        assert db.get_record_id("wb-1", "/posts", "a.json") is None

    def test_delete_nonexistent_no_error(self):
        db.delete_file_index("wb-1", "/posts", "nope")  # Should not raise


class TestGetRecordId:
    def test_returns_none_for_missing(self):
        assert db.get_record_id("wb-1", "/posts", "nope.json") is None
