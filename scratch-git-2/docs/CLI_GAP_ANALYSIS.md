# CLI Upload / Download — Gap Analysis

Deep analysis of the upload/download/publish reconciliation model.
For the model itself see [CLI_UPLOAD_DOWNLOAD.md](CLI_UPLOAD_DOWNLOAD.md).

---

## Gaps by Severity

### High

#### 1. Silent "ours wins" on field conflicts — user loses remote data

`merge_file_contents` uses `Conflict::ResolveWithOurs`.
When both sides changed the same lines, local always wins and the user is never told.

| Merge site | "ours" | Consequence |
|---|---|---|
| Upload approved-state merge | local dirty | Remote concurrent change to same field is silently discarded |
| Download approved-state merge | local dirty | Same — even though during download the server state would be the expected winner |
| Working-tree rebase (upload & download) | working tree | Unapproved local edits beat newly-arrived approved changes to the same field |

`conflicts_auto_resolved` is counted but never surfaced in a way that lets the user know their
data was overwritten.
The driver only checks whether files were preserved by path, not whether field values were correct.

---

#### 2. Text-level merge on JSON is semantically wrong

`merge_content` runs `imara_diff::Histogram` on raw bytes.
For JSON record files this is incorrect because:

- Two edits to **different fields** in the same JSON object can land on adjacent lines and produce
  a spurious conflict or mangled output.
- **Field ordering matters** — if local and remote produce the same fields in a different order,
  byte comparison sees them as different even though the records are semantically identical.
- The ID type bug fixed in `publish-from-git` is a concrete example: `"id": "4"` vs `"id": 4`.
  After the server normalizes and commits back to git, the next merge has two byte-inequivalent
  representations of the same value, which causes a merge action where none is warranted.

The correct merge unit for these files is the **JSON field**, not the text line.

---

#### 3. No end-to-end test covering the server publish path

The driver validates the CLI upload → download cycle.
`publish-from-git` is a separate server-side process that the driver does not call.
The ID type bug would never have been caught by the driver.

There is no end-to-end test that covers:

```
upload → publish-from-git → download → verify field types match what a fresh pull produces
```

---

#### 4. JSON normalization drift accumulates with every publish

The pull path returns raw Postgres values (numeric IDs stay numeric).
`publish-from-git` writes back to git with potentially different types or formatting.
After one publish cycle the bytes on disk diverge from what a fresh pull would produce.

This means:
- The `merge_base_map` can be byte-inequivalent to `local_dirty_map` even for unchanged fields.
- Text-level diffs see false changes.
- This accumulates with every publish cycle.

The ID type fix is a symptom. The root cause is that there is no canonical serialization enforced
across the pull and publish paths.

---

### Medium

#### 5. "Both sides added the same file" silently discards remote

In `compute_merge_actions` (see the `else { match (local_content, remote_content)` branch):
if both local and remote have a file that was **not** in base (both sides created a new record at
the same path), the action is `KeepLocal` with no warning and no merge attempt.
The remote's new record is silently discarded during upload.

---

#### 6. No merge base → hard error with no fallback

If `merge_base(local dirty, origin/dirty)` returns nothing the CLI errors immediately.
This can happen after:

- A fresh clone with shallow history
- The server force-pushing dirty (workbook reset, admin operation)
- A team member onboarding onto an existing workbook mid-stream

There is no fallback strategy (e.g. treat remote as authoritative when no base exists).
In production this would be a hard stop requiring manual intervention.

---

#### 7. Download approved-state conflict bias is counterintuitive

`download_single_repo` calls `prepare_upload_merge` with `ours = local dirty`.
When origin/dirty has an approved change to the same field as local dirty, local dirty wins.
For a download, users would generally expect the server state to win since it is the canonical
published state.
This is not necessarily incorrect (it is a true 3-way merge, not a reset) but it is undocumented
and asymmetric with expectations.

---

#### 8. Binary file local-wins with no warning

In `merge_content`, binary files always return local:

```rust
return local.or(remote).cloned().unwrap_or_default();
```

During the working-tree rebase after download, if the server published a new version of a binary
asset, the local version silently wins. The user is never notified.

---

### Low

#### 9. `merge_content` UTF-8 failure is completely silent

```rust
Err(_) => local.cloned().unwrap_or_default(),
```

If `merge_file_contents` fails with a UTF-8 error, local content is returned silently:
no warning is added to `messages`, `conflicts_auto_resolved` is not incremented, and if local is
`None` an empty file is written. This is data loss with no signal.

---

#### 10. Upload early-exit does not sync the dirty ref

When `local_unreviewed.is_empty() && local_plan_map.is_empty()` and the maps are equal, upload
returns `no_changes` without updating `refs/heads/dirty` to match `origin/dirty`.

If they are equal in content but have different commit hashes (local is a few commits behind),
the next merge-base computation finds an unnecessarily old ancestor and does more merge work than
needed. Not a correctness issue, but worth noting.

---

#### 11. Single-file publish isolation gap (acknowledged, unfixed)

Upload is not filtered when the publish plan is filtered to a single file.
Other approved local changes are pushed to `origin/dirty` as part of a single-file publish and
sit there in unpublished limbo until the next full publish picks them up.

---

## Summary Table

| # | Gap | Severity |
|---|---|---|
| 1 | Silent "ours wins" on field conflicts — user loses remote data without knowing | High |
| 2 | Text-level merge on JSON — semantically wrong, produces false conflicts | High |
| 3 | No end-to-end test covering the server publish path | High |
| 4 | JSON normalization drift between pull and publish accumulates | High |
| 5 | Both sides add same file → remote silently discarded | Medium |
| 6 | No merge base → hard error, no fallback | Medium |
| 7 | Download approved-state conflict bias is counterintuitive | Medium |
| 8 | Binary file local-wins with no warning | Medium |
| 9 | `merge_content` UTF-8 failure is silent | Low |
| 10 | Upload early-exit does not sync dirty ref | Low |
| 11 | Single-file publish not isolated at upload layer | Low |
