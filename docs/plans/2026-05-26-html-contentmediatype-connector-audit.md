# HTML `contentMediaType` connector audit

- **Date:** 2026-05-26
- **Author:** Chris Hoefgen
- **Related:** Linear [DEV-10192](https://linear.app/whalesync/issue/DEV-10192) — Render HTML in preview (toggle rich text vs raw)

## Problem statement

The desktop preview now offers a Source / Prettified / Rich text toggle in the focused field view. The Rich text segment only appears when the field's JSON Schema has `contentMediaType: 'text/html'` (see `isHtmlMediaType` in [scratch-desktop/src/renderer/src/pages/workspace/RecordFieldsGrid.tsx](../../scratch-desktop/src/renderer/src/pages/workspace/RecordFieldsGrid.tsx)).

Today only two connectors set `contentMediaType` on string fields:

| Connector | Field | Value | File |
|---|---|---|---|
| Webflow | `FieldType.RichText` | `text/html` | [webflow-json-schema.ts:46](../../server/src/remote-service/connectors/library/webflow/webflow-json-schema.ts#L46) |
| Airtable | `RICH_TEXT` | `text/airmark` (NOT html — leave alone) | [airtable-json-schema.ts:113](../../server/src/remote-service/connectors/library/airtable/airtable-json-schema.ts#L113) |

Several other connectors expose HTML body fields that aren't currently tagged, so users see raw `<p>` markup in the preview pane instead of rendered content.

## Goal

Identify which connectors carry HTML in string fields and need `contentMediaType: 'text/html'` added. **This document is a punch list for manual review** — each entry should be verified against the source API's documentation before changing the schema.

## Verification reminders before editing

- Confirm the field actually contains HTML (not Markdown, not plain text, not a structured rich-text object like Notion blocks or Wix Ricos).
- Check the per-connector `__tests__/<connector>-json-schema.spec.ts` after the change so the expected schema fixture matches.
- The desktop walks `properties[part]` per `.`-delimited segment in `getFieldContentMediaType` ([RecordDetailView.tsx:201](../../scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx#L201)). Adding `contentMediaType` to a nested subfield (e.g. WordPress's `rendered`) Just Works as long as the columnEffectivePath resolves to that subfield.

---

## Action list — high confidence (likely safe to add)

### 1. Intercom — Articles & Conversations

- **File:** [server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts](../../server/src/remote-service/connectors/library/intercom/intercom-json-schema.ts)
- **Fields to update:**
  - `body` on Articles — line 20. Description already says "Article body (HTML)".
  - `conversation_parts[*].body` on Conversations — line ~176.
  - `source.body` on Conversations — line ~230.
- **Change:** add `contentMediaType: 'text/html'` to the existing `Type.Union([Type.String(), Type.Null()], { ... })` options.
- **API docs to confirm:** https://developers.intercom.com/intercom-api-reference/reference/the-article-model and https://developers.intercom.com/intercom-api-reference/reference/the-conversation-model — verify `body` is always HTML (not Markdown).

### 2. Brevo — Email Templates

- **File:** [server/src/remote-service/connectors/library/brevo/brevo-json-schema.ts](../../server/src/remote-service/connectors/library/brevo/brevo-json-schema.ts#L130)
- **Field:** `htmlContent` on Templates — line 130. Description already says "HTML body content".
- **Change:** add `contentMediaType: 'text/html'` to the existing options.
- **API docs to confirm:** https://developers.brevo.com/reference/getsmtptemplates — the schema lists `htmlContent` as the rendered HTML body.

### 3. WordPress — all `*.rendered` subfields

- **File:** [server/src/remote-service/connectors/library/wordpress/wordpress-json-schema.ts:116](../../server/src/remote-service/connectors/library/wordpress/wordpress-json-schema.ts#L116)
- **Pattern:** WP REST returns text fields as `{ raw, rendered, protected }` objects (e.g. `title.rendered`, `content.rendered`, `excerpt.rendered`). The connector already has a dedicated branch (`if (field.properties?.rendered)`) that emits the `Type.Object({ raw, rendered, … })` schema.
- **Change:** add `contentMediaType: 'text/html'` to the `rendered: Type.String({ ... })` call (one insertion point covers every rendered subfield).
- **Note:** the existing description says "Display-ready HTML. Edit \"raw\" to modify this." — already self-documenting.
- **API docs to confirm:** https://developer.wordpress.org/rest-api/reference/posts/ — `content.rendered` is the canonical HTML output, including theme filters.

### 4. Shopify — `bodyHtml` and `descriptionHtml`

- **Location:** generated; patch the **codegen config**, not the emitted schema files.
- **Schema files affected (do not edit directly — they have a "Do Not Edit" CLAUDE.md):**
  - [graphql/schemas/products.schema.ts](../../server/src/remote-service/connectors/library/shopify/graphql/schemas/products.schema.ts) — `bodyHtml` (line 25), `descriptionHtml` (line 66).
  - [graphql/schemas/collections.schema.ts](../../server/src/remote-service/connectors/library/shopify/graphql/schemas/collections.schema.ts) — `descriptionHtml` (line 26).
  - `graphql/schemas/product-variants.schema.ts`, `graphql/schemas/order-line-items.schema.ts` — nested product references include `bodyHtml`/`descriptionHtml` mirrors.
- **Where the patch lands:**
  - Codegen entry point: [tools/graphql-codegen/src/shopify/config.ts](../../tools/graphql-codegen/src/shopify/config.ts) (per-entity field config).
  - Codegen emitter: [tools/graphql-codegen/src/plugins/typebox-plugin.ts:170](../../tools/graphql-codegen/src/plugins/typebox-plugin.ts#L170) — currently emits a "Mark read-only fields" side-effect block (`Schema.properties.X[X_SCRATCH_READONLY] = true`) after the schema literal. The same pattern can emit `Schema.properties.X.contentMediaType = 'text/html';` lines for a configured HTML-field list.
- **Change steps:**
  1. Extend the codegen entity config in `config.ts` with an `htmlFields: string[]` (parallel to whatever drives the read-only list).
  2. Extend `typebox-plugin.ts` to emit `contentMediaType` side-effect assignments for those fields.
  3. Re-run `yarn codegen:shopify` to refresh the generated files.
- **API docs to confirm:** https://shopify.dev/docs/api/admin-graphql/latest/objects/Product — both `bodyHtml` and `descriptionHtml` are documented as HTML; `description` (plain) sits alongside them.
- **Other candidates to investigate during this pass:** Shopify Articles and Pages also expose HTML body fields if they're added to the connector later. Not present in the current schemas (search showed no `articles.schema.ts` / `pages.schema.ts`), so no action today.

---

## Action list — needs verification (medium / low confidence)

### 5. Affinity — Notes `content.html`

- **File:** [server/src/remote-service/connectors/library/affinity/affinity-json-schema.ts:381](../../server/src/remote-service/connectors/library/affinity/affinity-json-schema.ts#L381)
- **Current shape:** `content: Type.Object({ html: Type.Union([Type.String(), Type.Null()]) })`.
- **Change:** add `contentMediaType: 'text/html'` to the inner `html` field's options.
- **Verify before editing:**
  - Confirm `content.html` is always HTML for all note `type` values (text, AI-notetaker, interaction). https://api-docs.affinity.co/ — Notes endpoint.
  - The desktop's `columnEffectivePaths` must surface `content.html` as a focusable path; if it currently only exposes `content`, this won't show the toggle until the user picks the html subfield.

### 6. Wix Blog — `richContent` (probably leave alone)

- **File:** [server/src/remote-service/connectors/library/wix/wix-blog/wix-blog-json-schema.ts](../../server/src/remote-service/connectors/library/wix/wix-blog/wix-blog-json-schema.ts) (around line 75–82)
- **Status:** `richContent` holds a Wix **Ricos** document (structured nodes), not HTML. Tagging it `text/html` would render gibberish.
- **Action:** **No change recommended.** If we ever want a "preview" for Ricos, it needs its own renderer (similar to how Notion blocks would need a Notion renderer), not the HTML one.

### 7. Audienceful — `notes` field

- **File:** [server/src/remote-service/connectors/library/audienceful/audienceful-json-schema.ts](../../server/src/remote-service/connectors/library/audienceful/audienceful-json-schema.ts) (line 51–54)
- **Current state:** description says "Accepts HTML or plain text". Schema is plain `Type.String`.
- **Action:** **Skip for now.** If the field can hold either format, tagging it HTML will mis-render plain-text rows. If Audienceful normalizes to HTML on read, then add the tag; verify with their API team first.

---

## No change needed

These connectors were audited and do not have string fields carrying HTML body content:

| Connector | Notes |
|---|---|
| Attio | Permissive attribute schemas; no rich-text field detected. |
| HubSpot | All properties are strings, but standard properties don't include explicit HTML body fields (blog post body would be a future addition). Revisit if HubSpot Blog support lands. |
| Linear | GraphQL-generated; descriptions and content are Markdown, not HTML. |
| Memberstack | Member metadata only. |
| Moco | `footer` field is documented "HTML footer for invoices" but only appears in invoice templates — probably not a previewed field; can be revisited. |
| Notion | `rich_text` and `page_content` are Notion block arrays, not HTML. Would need a Notion-block renderer, separate effort. |
| Pipedrive | No HTML fields. |
| Postgres / Supabase / pg-common | Dynamic per-database schemas; no mechanism to mark columns as HTML. Leave to user-defined views if ever needed. |
| QuickBooks | No rich-text fields. |
| Stripe | No HTML fields. |
| YouTube | `snippet.description` is plain text. |
| Generic API | User-defined schemas — `contentMediaType` passes through if the user sets it in their config. No connector-side change required. |

## Suggested rollout order

1. **WordPress** (single-line change, immediately benefits every record with a `rendered` subfield).
2. **Brevo** (single line).
3. **Intercom** (three lines, one connector).
4. **Shopify** (codegen change — touches two configs and regenerates four schema files; biggest blast radius so do last).
5. **Affinity** (after confirming `content.html` is HTML for all note types).

Each can ship as its own PR; they're independent. Add a test assertion in each connector's `__tests__/<connector>-json-schema.spec.ts` that the expected field now carries `contentMediaType: 'text/html'`.

## Out of scope

- Adding rich-text rendering for **non-HTML** rich formats (Notion blocks, Wix Ricos, Airtable airmark). Each would need its own renderer; the current desktop component only handles HTML.
- Rich-text rendering during diff view — the diff renderer operates on the raw string and would need a separate design to diff DOM trees.
