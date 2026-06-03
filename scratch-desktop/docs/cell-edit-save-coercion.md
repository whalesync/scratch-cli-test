# Cell-Edit Save Coercion

When you edit a cell in the data grid (or a field in the record detail view) and save, Scratch has to turn the text you typed into an actual JSON value inside the record file — a string, a number, a boolean, `null`, an object, and so on. This doc explains how it decides which.

The mental model is simple: **editing a field is like editing a value in a text file.** We save what you typed as faithfully as we can. We don't reshape your data to fit a schema, and we don't reject input that looks "wrong" — at worst we flag it for you.

## The one principle

**The value already in the field decides its type. The schema is only a hint — and only for empty fields.**

- If the field already holds a value, we keep that value's type. Text stays text; a number stays a number. Editing `25000` to `30000` keeps it a number; editing the text `"25000"` to `"30000"` keeps it text (so a code or ID that happens to be all digits never silently turns into a number).
- If the field is **empty**, there's no existing type to go on — so we fall back to the connector's schema for a hint about whether it should be a number, text, etc.
- The schema never decides the *shape* of what's written. It can suggest "this empty field is a number," but it can't restructure or overwrite data that's already there. (This is the whole point — see "Why this can't mangle a Notion field's structure" below.)

## What gets saved

Putting it together — given what's currently in the field, the connector's type hint, and the text you typed:

| You're editing a field that… | …and you type | Saved as |
| --- | --- | --- |
| already holds **text** | `30000` | `"30000"` (text — kept as-is) |
| already holds a **number / boolean / object** | `30000` | `30000` (number) |
| is **empty**, schema says it's a **number** | `30000` | `30000` (number) |
| is **empty**, schema says it's **text** | `30000` | `"30000"` (text) |
| is **empty**, no schema available | `30000` | `30000` (parsed as JSON) |
| anything | _(clear it)_, field is **nullable** | `null` |
| anything | _(clear it)_, field is **not** nullable | `""` (empty text) |

The number/text distinction for an **empty** field is exactly where the schema hint earns its keep: with nothing already in the field, only the schema can tell us whether `30000` should be the number `30000` or the text `"30000"`.

## Example: a Notion number

Notion stores each property as a small wrapper object, and the cell edits the value *inside* it:

```jsonc
"Typical Check Size": { "id": "AF<M", "type": "number", "number": 25000 }
//                       the cell edits this inner value ──────────^
```

- Edit it to `30000` → only the inner number changes; the wrapper is untouched:
  `{ "id": "AF<M", "type": "number", "number": 30000 }`.
- If it were empty and the schema says number → `30000`; if the schema says text → `"30000"`.
- Clear it → `null` (Notion's number is nullable), giving `{ …, "number": null }`.

## Why this can't mangle a Notion field's structure

The original motivation ([DEV-10308](https://linear.app/whalesync/issue/DEV-10308)) was a bug where editing that number wrote a bare `30000` **over the whole wrapper** — `"Typical Check Size": 30000` — destroying the `id`/`type` around it and getting silently dropped when published. Two things make that impossible now:

1. **The edit always targets the inner value, never the wrapper.** Where the bytes go is decided by the column, not by the schema — so the surrounding structure is never the thing being replaced.
2. **The schema hint only applies to *empty* fields.** When the field already holds the wrapper object, we just re-parse the JSON you edited back into the same object; the schema is never consulted.

## Typing something that doesn't match is fine

Saving **never fails on a type mismatch.** Type `abc` into a number field and we save the text `"abc"` — then the separate validators flag the cell. We don't block the edit, because the schema itself might be wrong (maybe that field really can hold text). We prefer flexibility, and we surface problems rather than swallowing or rejecting them.

---

## Where this lives in the code

The rule is one pure function, applied by the main-process write path, with the grid mirroring it for its optimistic update.

| Piece | Location |
| --- | --- |
| The rule itself | [`coerceCellInputTextAgainstExistingValueOrSchema`](../src/shared/cell-value-coercion.ts) |
| The schema hint resolver (`{ scalarType, nullable }` for a field) | [`resolveSchemaLeafHint`](../src/shared/cell-value-coercion.ts) |
| Authoritative write (reads schema, replaces just that leaf, then snapshots into `accepted-patches.json`) | [`acceptFieldEditFromInputText` → `writeWorkingFileFieldFromInputText`](../src/main/local-files.ts) |
| Grid cell edit / Approve (also computes the optimistic value) | [`FolderDataGrid.tsx` → `acceptGridCellChange`](../src/renderer/src/pages/workspace/FolderDataGrid.tsx) |
| Record-detail edit (mirrors the main process's returned value, no local coercion) | [`RecordDetailView.tsx` → `commitFieldEdit`](../src/renderer/src/pages/workspace/RecordDetailView.tsx) |
| Detail "Approve" button (delegates to the same write, so it can't retype a leaf either) | `RecordDetailView.tsx` → `handleApproveFieldClick` → `acceptUnreviewedFieldEdit` |

Implementation notes:

- **"Leaf" = the exact JSON node being edited.** A column's path can drill into a nested value (e.g. `properties.Typical Check Size.number`), and the write replaces only that node, leaving its siblings byte-identical. The path that picks the target is computed server-side per column — see [`buildPropertyCol`](../../server/src/remote-service/connectors/library/notion/notion-default-view.ts).
- **Optimistic match.** The grid resolves the same `{ scalarType, nullable }` hint from its in-memory `schema` that the main process reads from disk, and reads the existing value from the in-memory row, so the optimistic cell value matches what gets written. Any momentary divergence self-heals on the post-write refresh.
- **No connector branching.** The renderer and the coercion contain no Notion/Airtable/etc. special-casing; the server-computed column path decides the target and a generic scalar/nullability hint covers the empty case.

## What this is NOT

- **Not schema-driven type coercion.** A wrong or normalized schema can never retype or restructure a field that already has a value — the on-disk type wins.
- **Not a validator.** Out-of-type input is written verbatim and flagged elsewhere, not rejected here.
- **Not connector-aware.** The column path (server-computed) decides the write target; a generic scalar/nullability hint decides the empty case.

## Related

- [DEV-10308](https://linear.app/whalesync/issue/DEV-10308) — the bug and the design discussion behind this rule.
- [`CONNECTOR_GUIDE.md` → Store Raw API Responses](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md) — the "preserve external data fidelity" principle this is the write-path corollary of.
- [`REVIEW_MODEL.md`](../../scratch-git-2/docs/REVIEW_MODEL.md) — published / approved / local state model; the field-level accept/reject/discard semantics the save plugs into.
