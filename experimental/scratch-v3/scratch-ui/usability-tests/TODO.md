# Demo Walkthrough — Known Issues

Bugs found while building `demo_walkthrough.py`. Fix these before the Monday demo.

## Fixed

- **Flat folder paths**: `link_tables()` slugified the full "Base / Table" string into a flat path like `/base-table` instead of nesting as `/airtable/base/table`. Fixed in `connections.py` — splits on " / " and builds nested path segments.

- **Git repo never initialized**: `link_tables()` kicks off a background pull, but the git service (`scratch-git-2`) requires `/api/repo/manage/{id}/init` before any reads/writes. All pull jobs were failing with 500. Fixed by adding `git.init_repo()` call in `link_tables()` before starting the pull, and added `init_repo` method to `GitClient`.

- **Nav selectors wrong in demo script**: `_nav()` used `aside nav a` but nav links are in `header nav` (Files, Syncs, Review, Publish, History) and `aside footer` (Connections). Fixed selector to `header nav a, aside footer a`.

- **"Changes" nav label doesn't exist**: Demo used `_nav(page, "Changes")` but the actual nav link says "Review". Fixed to `_nav(page, "Review")`.

- **Publish is a separate page from Review**: Demo tried to find "Publish All" button on the Review page. Review only has Discard buttons. Publish All is on the separate Publish page (`/w/{id}/publish`). Fixed to navigate to Publish before clicking Publish All.

- **pydantic-settings rejects DEMO_* env vars**: `BaseSettings` in `config.py` rejected unknown env vars from `.env`. Fixed by adding `"extra": "ignore"` to model_config.

- **Missing `encrypted_credentials` column**: Older SQLite DB didn't have the column. Fixed via ALTER TABLE (and the schema in `db.py` already has it for fresh DBs).

- **Pull wrote to dirty branch only — all records showed as "added"**: The NestJS server writes pulled data to `main` branch then rebases `dirty`. The Python UI wrote to `dirty` only, so every pulled file appeared as a pending "added" change on the Review page. Fixed `pull_folder` in `engine.py` to write to `main` and call `git.rebase_dirty()` after. Added `rebase_dirty` method to `GitClient`.

- **Field edits silently failed (route ordering)**: `file_field_save` (`PATCH .../field`) was declared AFTER `file_save` (`PATCH .../{path:path}`). FastAPI's `{path:path}` greedily matched the `/field` suffix, so `file_save` ran instead — writing empty content to a wrong path while returning "Saved". Fixed by moving `file_field_save` before `file_save` in `files.py`.

## Verified Working

- [x] Airtable connect + pull produces visible records in folder table view (5 files, clean status)
- [x] Record editing (contenteditable blur save) works (field save creates single dirty file)

## Still To Verify

These are fixed but haven't been confirmed end-to-end yet:

- [ ] Review page shows diffs after edits
- [ ] Discard single file works from diff view
- [ ] Publish page commits remaining changes
- [ ] CSV download from folder table works
- [ ] CSV upload detects and writes changes
- [ ] WordPress connect + pull works (also needs repo init)
- [ ] Sync mapper field matching works
- [ ] Sync run produces dirty files
- [ ] Full 3-act demo passes end-to-end

## Troubleshooting Approach

To test incrementally without running the full demo:

```bash
# 1. Clean the DB
sqlite3 scratch.db "DELETE FROM connector_account; DELETE FROM data_folder; DELETE FROM sync; DELETE FROM job;"

# 2. Start the server (if not already running)
.venv/bin/python -m uvicorn app.main:app --reload --port 8000

# 3. Test connection + pull via curl
# Create connection
curl -X POST http://localhost:8000/w/wkb_EG4Kmc6giE/connections \
  -d "service=AIRTABLE&apiKey=YOUR_KEY"

# 4. Check job results
sqlite3 scratch.db "SELECT state, result FROM job ORDER BY created_at DESC LIMIT 1"

# 5. Check if files landed in git
curl http://localhost:3100/api/repo/read/REPO_ID/list?branch=dirty

# 6. Run just Act 1 of the demo (use -k to filter)
.venv/bin/python -m pytest usability-tests/demo_walkthrough.py --headed --browser chromium --slowmo 300 -s -x
```
