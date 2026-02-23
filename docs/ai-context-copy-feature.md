# AI Context Copy Feature

## Overview

The "Copy info for AI" feature allows users to copy structured workbook context to the clipboard so they can paste it into an AI agent (like Claude Code) to get help building sync definitions.

## How It Works

1. User opens the sync editor and switches to **JSON mode**
2. A **"Copy for AI"** button appears in the toolbar
3. Clicking it fetches all relevant workbook context from the server and copies it as Markdown to the clipboard
4. The user pastes this into an AI chat and asks it to build a sync definition
5. The AI responds with valid JSON that the user pastes back into the sync editor

## Server Endpoint

**`GET /workbooks/:workbookId/syncs/ai-context`**

Returns `{ markdown: string }` containing structured Markdown with:

- JSON schema definition for `SyncMapping`
- All linked folders with their IDs, field schemas, and annotations (readonly, foreign keys, suggested transformers)
- Available transformer documentation
- Connector-specific tips (only for connector types present in the workbook)
- An example sync (from existing syncs, or a generated minimal example)

### Implementation

- **Service method**: `SyncService.generateAiContext(workbookId, actor)`
- **Controller**: `SyncController.getAiContext()` — placed before the `:syncId` route to avoid route conflicts

## Client

- **API method**: `syncApi.getAiContext(workbookId)` in `client/src/lib/api/sync.ts`
- **Button**: In `SyncEditor.tsx`, visible only in JSON mode, disabled when no linked folders exist
- Uses `navigator.clipboard.writeText()` to copy the Markdown

## Extending

### Adding new transformers

1. Add the transformer type to `TransformerType` in `packages/shared-types/src/sync-mapping.ts`
2. Implement the transformer in `server/src/sync/transformers/`
3. Add documentation for it in the `generateAiContext` method's "Available Transformers" section

### Adding connector tips

Add a new entry to the `tipSections` array in `generateAiContext()`, keyed by the `Service` enum value.

### Schema annotations

The `SchemaField` interface in `server/src/utils/schema-helpers.ts` supports:

- `readonly` — from `x-scratch-readonly` in the JSON schema
- `foreignKey` — from `x-scratch-foreign-key` in the JSON schema
- `suggestedTransformer` — from `x-scratch-suggested-transformer` in the JSON schema
