"""Golden-folder integration test: sync + publish pipeline.

Ports the sync-publish E2E scenario from server/test/integration/sync-publish-e2e.spec.ts
to verify our Python/Rust engine produces identical results against a real scratch-git-2.

Prerequisites:
    - scratch-git-2 running on GIT_SERVICE_URL (default: http://localhost:3100)
    - scratch_engine compiled with `maturin develop` (needs run_sync + build_plan_from_git)

Run:
    cd scratch-ui && python -m pytest tests/test_sync_publish_golden.py -v
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import uuid

import httpx
import pytest


# ---------------------------------------------------------------------------
# Skip conditions
# ---------------------------------------------------------------------------

GIT_URL = os.environ.get("GIT_SERVICE_URL", "http://localhost:3100")


def _git_reachable():
    try:
        r = httpx.get(f"{GIT_URL}/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def _has_real_engine():
    """Check if the real compiled scratch_engine is available.

    The conftest stub (for unit tests) may have replaced the real module in
    sys.modules. We temporarily remove it to check the filesystem.
    """
    try:
        # Check if the real module is already loaded
        mod = sys.modules.get("scratch_engine")
        if mod and callable(getattr(mod, "run_sync", None)):
            return True
        # Temporarily remove stub to check filesystem
        saved = sys.modules.pop("scratch_engine", None)
        try:
            spec = importlib.util.find_spec("scratch_engine")
            return spec is not None and spec.origin is not None
        finally:
            if saved is not None:
                sys.modules["scratch_engine"] = saved
    except Exception:
        return False


def _load_real_engine():
    """Force-load the real compiled scratch_engine, replacing any stub."""
    if "scratch_engine" in sys.modules:
        mod = sys.modules["scratch_engine"]
        if callable(getattr(mod, "run_sync", None)):
            return mod  # already the real module
        del sys.modules["scratch_engine"]
    import scratch_engine
    return scratch_engine


pytestmark = [
    pytest.mark.skipif(not _has_real_engine(), reason="scratch_engine not compiled"),
    pytest.mark.skipif(not _git_reachable(), reason=f"scratch-git-2 not running at {GIT_URL}"),
]

scratch_engine = _load_real_engine()  # noqa: E402 — safe after skip checks

# ---------------------------------------------------------------------------
# Constants (matching server E2E defaults)
# ---------------------------------------------------------------------------

MATCH_COUNT = 2
CREATE_COUNT = 3
ORPHAN_DEST_COUNT = 1

SRC_TAGS_FOLDER_ID = "src-tags-folder"
DST_TAGS_FOLDER_ID = "dest-tags-folder"
SRC_POSTS_FOLDER_ID = "src-posts-folder"
DST_POSTS_FOLDER_ID = "dest-posts-folder"


# ---------------------------------------------------------------------------
# Data generators (port of generateTagData / generatePostData)
# ---------------------------------------------------------------------------


def generate_tag_data():
    """Returns (source_tags, dest_tags) matching server E2E test data."""
    source_tags = []
    dest_tags = []

    for i in range(MATCH_COUNT):
        source_tags.append({
            "path": f"src-tags/rec_tag_match_{i}.json",
            "content": json.dumps({
                "id": f"rec_tag_match_{i}",
                "fields": {"Name": f"Tag Match {i} Updated", "Slug": f"tag-match-{i}"},
            }),
        })
        dest_tags.append({
            "path": f"dest-tags/tag-match-{i}.json",
            "content": json.dumps({
                "id": 100 + i,
                "name": f"Tag Match {i}",
                "slug": f"tag-match-{i}",
            }),
        })

    for i in range(CREATE_COUNT):
        source_tags.append({
            "path": f"src-tags/rec_tag_create_{i}.json",
            "content": json.dumps({
                "id": f"rec_tag_create_{i}",
                "fields": {"Name": f"Tag Create {i}", "Slug": f"tag-create-{i}"},
            }),
        })

    for i in range(ORPHAN_DEST_COUNT):
        dest_tags.append({
            "path": f"dest-tags/tag-orphan-{i}.json",
            "content": json.dumps({
                "id": 900 + i,
                "name": f"Tag Orphan {i}",
                "slug": f"tag-orphan-{i}",
            }),
        })

    return source_tags, dest_tags


def generate_post_data():
    """Returns (source_posts, dest_posts) matching server E2E test data."""
    matched_tag_ids = [f"rec_tag_match_{i}" for i in range(MATCH_COUNT)]
    created_tag_ids = [f"rec_tag_create_{i}" for i in range(CREATE_COUNT)]
    all_tag_ids = matched_tag_ids + created_tag_ids

    def tags_for(i):
        tags = [all_tag_ids[i % len(all_tag_ids)]]
        if len(all_tag_ids) > 1:
            tags.append(all_tag_ids[(i + 1) % len(all_tag_ids)])
        return tags

    source_posts = []
    dest_posts = []

    for i in range(MATCH_COUNT):
        source_posts.append({
            "path": f"src-posts/rec_post_match_{i}.json",
            "content": json.dumps({
                "id": f"rec_post_match_{i}",
                "fields": {
                    "Title": f"Post Match {i} Updated",
                    "Slug": f"post-match-{i}",
                    "Tags": tags_for(i),
                },
            }),
        })
        dest_posts.append({
            "path": f"dest-posts/post-match-{i}.json",
            "content": json.dumps({
                "id": 200 + i,
                "title": f"Post Match {i}",
                "slug": f"post-match-{i}",
            }),
        })

    for i in range(CREATE_COUNT):
        source_posts.append({
            "path": f"src-posts/rec_post_create_{i}.json",
            "content": json.dumps({
                "id": f"rec_post_create_{i}",
                "fields": {
                    "Title": f"Post Create {i}",
                    "Slug": f"post-create-{i}",
                    "Tags": tags_for(i),
                },
            }),
        })

    for i in range(ORPHAN_DEST_COUNT):
        dest_posts.append({
            "path": f"dest-posts/post-orphan-{i}.json",
            "content": json.dumps({
                "id": 950 + i,
                "title": f"Post Orphan {i}",
                "slug": f"post-orphan-{i}",
            }),
        })

    return source_posts, dest_posts


# ---------------------------------------------------------------------------
# Table mappings & schemas
# ---------------------------------------------------------------------------

TAGS_TABLE_MAPPING = {
    "sourceDataFolderId": SRC_TAGS_FOLDER_ID,
    "destinationDataFolderId": DST_TAGS_FOLDER_ID,
    "columnMappings": [
        {"sourceColumnId": "fields.Name", "destinationColumnId": "name"},
        {"sourceColumnId": "fields.Slug", "destinationColumnId": "slug"},
    ],
    "recordMatching": {
        "sourceColumnId": "fields.Slug",
        "destinationColumnId": "slug",
    },
}

POSTS_TABLE_MAPPING = {
    "sourceDataFolderId": SRC_POSTS_FOLDER_ID,
    "destinationDataFolderId": DST_POSTS_FOLDER_ID,
    "columnMappings": [
        {"sourceColumnId": "fields.Title", "destinationColumnId": "title"},
        {"sourceColumnId": "fields.Slug", "destinationColumnId": "slug"},
        {
            "sourceColumnId": "fields.Tags",
            "destinationColumnId": "tags",
            "transformer": {
                "type": "source_fk_to_dest_fk",
                "options": {"referencedDataFolderId": SRC_TAGS_FOLDER_ID},
            },
        },
    ],
    "recordMatching": {
        "sourceColumnId": "fields.Slug",
        "destinationColumnId": "slug",
    },
}

SRC_TAGS_SCHEMA = {"idColumnRemoteId": "id"}
DST_TAGS_SCHEMA = {"idColumnRemoteId": "id", "slugColumnRemoteId": "slug"}
SRC_POSTS_SCHEMA = {"idColumnRemoteId": "id"}
DST_POSTS_SCHEMA = {
    "idColumnRemoteId": "id",
    "slugColumnRemoteId": "slug",
    "schema": {
        "type": "object",
        "properties": {
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "x-scratch-foreign-key": {"linkedTableId": DST_TAGS_FOLDER_ID},
            },
        },
    },
}

EMPTY_CTX = {"remoteIdMappings": {}, "fkRecordCache": {}}

ALL_SCHEMAS = [
    {"path": "src-tags/.scratch/schema.json", "content": json.dumps(SRC_TAGS_SCHEMA)},
    {"path": "dest-tags/.scratch/schema.json", "content": json.dumps(DST_TAGS_SCHEMA)},
    {"path": "src-posts/.scratch/schema.json", "content": json.dumps(SRC_POSTS_SCHEMA)},
    {"path": "dest-posts/.scratch/schema.json", "content": json.dumps(DST_POSTS_SCHEMA)},
]


# ---------------------------------------------------------------------------
# Git helper (sync httpx client for test setup)
# ---------------------------------------------------------------------------


class GitHelper:
    def __init__(self, base_url: str):
        self._client = httpx.Client(base_url=base_url, timeout=30.0)

    def init_repo(self, repo_id: str):
        r = self._client.post(f"/api/repo/manage/{repo_id}/init")
        r.raise_for_status()

    def write_files(self, repo_id: str, files: list[dict], branch: str = "main"):
        r = self._client.post(
            f"/api/repo/write/{repo_id}/files",
            params={"branch": branch},
            json={"files": files},
        )
        r.raise_for_status()

    def rebase(self, repo_id: str):
        """Rebase dirty onto main — updates merge_base tag."""
        r = self._client.post(
            f"/api/repo/write/{repo_id}/rebase",
            json={"strategy": "diff3"},
        )
        r.raise_for_status()

    def close(self):
        self._client.close()


# ---------------------------------------------------------------------------
# Repo helpers
# ---------------------------------------------------------------------------


def _seed_sync_repo() -> str:
    """Create and seed a fresh git repo with source + dest data on main."""
    repo_id = f"golden-sync-{uuid.uuid4().hex[:8]}"
    git = GitHelper(GIT_URL)
    git.init_repo(repo_id)

    source_tags, dest_tags = generate_tag_data()
    source_posts, dest_posts = generate_post_data()

    all_files = source_tags + dest_tags + source_posts + dest_posts + ALL_SCHEMAS
    git.write_files(repo_id, all_files, branch="main")
    git.close()
    return repo_id


def _run_tags_sync(repo_id: str) -> dict:
    """Run tags DATA sync on a repo, return parsed result."""
    result_json = scratch_engine.run_sync(
        GIT_URL, json.dumps(TAGS_TABLE_MAPPING),
        repo_id, "/src-tags", repo_id, "/dest-tags",
        "DATA", json.dumps(EMPTY_CTX), json.dumps([]),
        "Sync: golden-tags",
    )
    return json.loads(result_json)


def _run_full_sync(repo_id: str) -> dict:
    """Run all three sync phases, return final context and per-phase results."""
    # Phase 1: Tags DATA
    tags_parsed = _run_tags_sync(repo_id)
    ctx = tags_parsed["context"]

    # Phase 2: Posts DATA
    posts_data_json = scratch_engine.run_sync(
        GIT_URL, json.dumps(POSTS_TABLE_MAPPING),
        repo_id, "/src-posts", repo_id, "/dest-posts",
        "DATA", json.dumps(ctx), json.dumps([]),
        "Sync: golden-posts-data",
    )
    posts_data_parsed = json.loads(posts_data_json)
    ctx = posts_data_parsed["context"]

    # Phase 3: Posts FK_MAPPING
    posts_fk_json = scratch_engine.run_sync(
        GIT_URL, json.dumps(POSTS_TABLE_MAPPING),
        repo_id, "/src-posts", repo_id, "/dest-posts",
        "FOREIGN_KEY_MAPPING", json.dumps(ctx), json.dumps([]),
        "Sync: golden-posts-fk",
    )
    posts_fk_parsed = json.loads(posts_fk_json)
    ctx = posts_fk_parsed["context"]

    return {
        "tags_data": tags_parsed,
        "posts_data": posts_data_parsed,
        "posts_fk": posts_fk_parsed,
        "context": ctx,
    }


# ---------------------------------------------------------------------------
# Fixtures — each creates its own repo to avoid cross-test interference
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def tags_sync_result():
    """Fresh repo + tags DATA sync run once. All tag tests read from cache."""
    repo_id = _seed_sync_repo()
    return _run_tags_sync(repo_id)


@pytest.fixture(scope="module")
def full_sync_results():
    """Fresh repo + full sync pipeline run once. Post tests read from cache."""
    repo_id = _seed_sync_repo()
    return _run_full_sync(repo_id)


# ---------------------------------------------------------------------------
# Sync tests
# ---------------------------------------------------------------------------


class TestSyncTagsData:
    """Phase B: Sync tags — DATA phase."""

    def test_no_errors(self, tags_sync_result):
        result = tags_sync_result["output"]["result"]
        assert result["errors"] == []

    def test_creates_and_updates(self, tags_sync_result):
        result = tags_sync_result["output"]["result"]
        assert result["created"] == CREATE_COUNT  # 3
        assert result["updated"] == MATCH_COUNT  # 2

    def test_updated_tags_preserve_dest_ids(self, tags_sync_result):
        files = tags_sync_result["output"]["filesToWrite"]
        by_path = {f["path"]: json.loads(f["content"]) for f in files}

        for i in range(MATCH_COUNT):
            path = f"dest-tags/tag-match-{i}.json"
            assert path in by_path, f"Missing updated tag file: {path}"
            content = by_path[path]
            assert content["id"] == 100 + i, "Dest numeric ID should be preserved"
            assert content["name"] == f"Tag Match {i} Updated"
            assert content["slug"] == f"tag-match-{i}"

    def test_created_tags_get_temp_ids(self, tags_sync_result):
        files = tags_sync_result["output"]["filesToWrite"]

        # Created files have slug-based filenames (tag-create-N.json)
        created = [f for f in files if "tag-match" not in f["path"]]
        assert len(created) == CREATE_COUNT

        for f in created:
            content = json.loads(f["content"])
            assert str(content["id"]).startswith("spub_"), (
                f"Created tag should have spub_ temp ID, got: {content['id']}"
            )


class TestSyncPostsData:
    """Phase C: Sync posts — DATA phase (no FK resolution yet)."""

    def test_creates_and_updates(self, full_sync_results):
        result = full_sync_results["posts_data"]["output"]["result"]
        assert result["errors"] == []
        assert result["created"] == CREATE_COUNT  # 3
        assert result["updated"] == MATCH_COUNT  # 2


class TestSyncPostsFkMapping:
    """Phase D: Sync posts — FOREIGN_KEY_MAPPING phase."""

    def test_all_posts_updated_with_tags(self, full_sync_results):
        fk_result = full_sync_results["posts_fk"]["output"]["result"]
        assert fk_result["errors"] == []
        assert fk_result["updated"] == MATCH_COUNT + CREATE_COUNT  # 5

    def test_tags_field_contains_valid_refs(self, full_sync_results):
        files = full_sync_results["posts_fk"]["output"]["filesToWrite"]
        assert len(files) == MATCH_COUNT + CREATE_COUNT  # 5

        for f in files:
            content = json.loads(f["content"])
            assert "tags" in content, f"Post {f['path']} missing tags field"
            tags = content["tags"]
            assert isinstance(tags, list) and len(tags) > 0

            for tag_ref in tags:
                tag_str = str(tag_ref)
                # Each ref is either a numeric dest ID or a @/ pseudo-ref
                is_numeric = tag_str.isdigit() or isinstance(tag_ref, int)
                is_pseudo_ref = tag_str.startswith("@/")
                assert is_numeric or is_pseudo_ref, (
                    f"Expected numeric ID or @/ pseudo-ref, got: {tag_ref}"
                )

    def test_matched_post_has_resolved_matched_tag(self, full_sync_results):
        """Post match 0 references rec_tag_match_0 which maps to dest ID 100."""
        files = full_sync_results["posts_fk"]["output"]["filesToWrite"]

        # Find post-match-0
        match_0 = None
        for f in files:
            content = json.loads(f["content"])
            if content.get("slug") == "post-match-0":
                match_0 = content
                break

        assert match_0 is not None, "post-match-0 not found in FK output"
        tags = match_0["tags"]
        # rec_tag_match_0 → dest ID 100, rec_tag_match_1 → dest ID 101
        tag_strs = [str(t) for t in tags]
        assert "100" in tag_strs or 100 in tags, (
            f"Expected matched tag ID 100 in tags, got: {tags}"
        )


# ---------------------------------------------------------------------------
# Publish plan tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def publish_repo():
    """Git repo with pre-sync state on main and post-sync state on dirty.

    After writing base files to main, we rebase dirty onto main so that
    merge_base points to main's HEAD. Then dirty-only changes (edits + creates)
    are written on top.
    """
    repo_id = f"golden-pub-{uuid.uuid4().hex[:8]}"
    git = GitHelper(GIT_URL)
    git.init_repo(repo_id)

    _, dest_tags = generate_tag_data()
    _, dest_posts = generate_post_data()
    dest_schemas = [
        {"path": "dest-tags/.scratch/schema.json", "content": json.dumps(DST_TAGS_SCHEMA)},
        {"path": "dest-posts/.scratch/schema.json", "content": json.dumps(DST_POSTS_SCHEMA)},
    ]

    # Main: pre-sync dest files (matched + orphan)
    git.write_files(repo_id, dest_tags + dest_posts + dest_schemas, branch="main")

    # Rebase dirty onto main — now merge_base = main's HEAD, dirty = main's tree
    git.rebase(repo_id)

    # Dirty: write only the CHANGED files on top of main's tree
    dirty_files = []

    # Updated matched tags (name changed by sync)
    for i in range(MATCH_COUNT):
        dirty_files.append({
            "path": f"dest-tags/tag-match-{i}.json",
            "content": json.dumps({
                "id": 100 + i,
                "name": f"Tag Match {i} Updated",
                "slug": f"tag-match-{i}",
            }),
        })

    # Created tags (new files, spub_ temp IDs)
    for i in range(CREATE_COUNT):
        dirty_files.append({
            "path": f"dest-tags/tag-create-{i}.json",
            "content": json.dumps({
                "id": f"spub_tag_{i}",
                "name": f"Tag Create {i}",
                "slug": f"tag-create-{i}",
            }),
        })

    # Updated matched posts (title changed, tags added)
    for i in range(MATCH_COUNT):
        dirty_files.append({
            "path": f"dest-posts/post-match-{i}.json",
            "content": json.dumps({
                "id": 200 + i,
                "title": f"Post Match {i} Updated",
                "slug": f"post-match-{i}",
                "tags": ["100", "@/dest-tags/tag-create-0.json"],
            }),
        })

    # Created posts (new files, spub_ temp IDs, with tags)
    for i in range(CREATE_COUNT):
        dirty_files.append({
            "path": f"dest-posts/post-create-{i}.json",
            "content": json.dumps({
                "id": f"spub_post_{i}",
                "title": f"Post Create {i}",
                "slug": f"post-create-{i}",
                "tags": ["100", "@/dest-tags/tag-create-0.json"],
            }),
        })

    # Orphan files are already on dirty via rebase — no need to rewrite them

    git.write_files(repo_id, dirty_files, branch="dirty")
    git.close()
    yield repo_id


def _build_publish_file_index():
    """File index mapping dest paths to remote record IDs (matched + orphan)."""
    index = {}
    for i in range(MATCH_COUNT):
        index[f"dest-tags/tag-match-{i}.json"] = str(100 + i)
        index[f"dest-posts/post-match-{i}.json"] = str(200 + i)
    for i in range(ORPHAN_DEST_COUNT):
        index[f"dest-tags/tag-orphan-{i}.json"] = str(900 + i)
        index[f"dest-posts/post-orphan-{i}.json"] = str(950 + i)
    return index


class TestPublishPlanGolden:
    """Phase E: Build publish plan from git state."""

    def _build_plan(self, repo_id):
        repo_folders = [{
            "repoId": repo_id,
            "folders": [
                {"id": DST_TAGS_FOLDER_ID, "path": "/dest-tags"},
                {"id": DST_POSTS_FOLDER_ID, "path": "/dest-posts"},
            ],
        }]
        plan_json = scratch_engine.build_plan_from_git(
            GIT_URL,
            json.dumps(repo_folders),
            json.dumps(_build_publish_file_index()),
        )
        return json.loads(plan_json)

    def test_edit_count(self, publish_repo):
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        edits = [o for o in ops if o["phase"] == "edit"]
        assert len(edits) == MATCH_COUNT * 2, (
            f"Expected {MATCH_COUNT * 2} edits (matched tags + posts), got {len(edits)}"
        )

    def test_create_count(self, publish_repo):
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        creates = [o for o in ops if o["phase"] == "create"]
        assert len(creates) == CREATE_COUNT * 2, (
            f"Expected {CREATE_COUNT * 2} creates (new tags + posts), got {len(creates)}"
        )

    def test_backfill_present(self, publish_repo):
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        backfills = [o for o in ops if o["phase"] == "backfill"]
        assert len(backfills) > 0, "Expected backfill operations for FK pseudo-refs"

    def test_create_ops_have_temp_ids(self, publish_repo):
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        creates = [o for o in ops if o["phase"] == "create"]

        for op in creates:
            content = op.get("content", {})
            id_val = str(content.get("id", ""))
            assert id_val.startswith("spub_"), (
                f"Create op should have spub_ temp ID, got: {id_val}"
            )

    def test_edit_ops_have_changed_fields(self, publish_repo):
        """Edit ops should include changedFields (sparse diff from main)."""
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        edits = [o for o in ops if o["phase"] == "edit"]

        for op in edits:
            changed = op.get("changedFields", {})
            assert changed, f"Edit op has empty changedFields: {op.get('path')}"

    def test_no_orphan_operations(self, publish_repo):
        """Orphan files are unchanged — should not appear in the plan."""
        plan = self._build_plan(publish_repo)
        ops = plan.get("operations", [])
        paths = [o.get("path", "") for o in ops]
        for i in range(ORPHAN_DEST_COUNT):
            assert not any(f"tag-orphan-{i}" in p for p in paths), (
                f"Orphan tag-orphan-{i} should not be in the plan"
            )
            assert not any(f"post-orphan-{i}" in p for p in paths), (
                f"Orphan post-orphan-{i} should not be in the plan"
            )
