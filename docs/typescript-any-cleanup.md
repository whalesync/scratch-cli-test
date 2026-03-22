# TypeScript `any` Cleanup Plan

## Motivation

We audited all `any` usage across the codebase and cleaned up everything fixable. This doc tracks the current state and what's left.

## Current State (after Phase 1-6 cleanup)

### Production code: clean

The only remaining `any` in production code is:

#### Generic type constraints in `JobDefinitionBuilder` (~5 occurrences)

**File:** `server/src/worker/jobs/base-types.ts`

`JobHandlerBuilder<TDefinition extends JobDefinitionBuilder<any, any, any, any, any>>` uses `any` in the `extends` clause because TypeScript's `infer` pattern requires `any` constraints to match all possible instantiations. `unknown` is too restrictive here.

**Fix:** This is a TypeScript language limitation. No fix needed — this is the correct pattern.

### Test code: clean

All test files have been cleaned up. Zero `as any`, `: any`, or `<any>` remain in `*.spec.ts` files.

## Next step: Enable the ESLint rule

The only remaining `any` is the unfixable `JobDefinitionBuilder` constraint. Enable `@typescript-eslint/no-explicit-any` as `error` in `server/eslint.config.mjs` and add a single `eslint-disable-next-line` to `base-types.ts`.

The client ESLint config (`eslint-config-next/typescript`) doesn't enable this rule either — consider adding it there too.

## What we already fixed (Phases 1-6)

### Phase 6

- Notion block-diff: extracted `getBlockValue` helper for type-safe block property access, replaced 23 `any` casts
- Notion rich-text-conversion: defined `NotionMediaValue`, `NotionRichTextBlockValue`, `NotionLinkValue` interfaces
- Notion block-diff-executor: typed return values and parameters, replaced `blocks.update` archived cast with `blocks.delete`
- Notion rich-text-push: imported `ChildNode`/`DataNode` from domhandler, removed `(block as any).children`
- json-cycle.ts: replaced all `any` with `unknown`, removed blanket `/* eslint-disable */` that suppressed all rules
- Removed all 5 file-level eslint-disable blocks from Notion conversion files

### Phase 5

- Eliminated all `any` from test files (80+ occurrences across 12 spec files)
- `sync.service.spec.ts`: typed `MOCK_WORKBOOK` and `MOCK_SCHEMA_SPEC` at declaration, removed ~30 `as any` casts
- `stripe-payment.service.spec.ts`: created `MockUser` interface, fixed private member access pattern
- `pull-linked-folder-files.job.spec.ts`: replaced `jest.Mocked<any>` with actual service types
- `pull-files.job.spec.ts`: same pattern as above
- `publish-data-folder.job.spec.ts`: typed mock factories and checkpoint access
- `sync.controller.spec.ts`: typed DTO casts and job return values
- `cli-workbook.controller.spec.ts`: typed workbook mock
- `stale-job-reaper.service.spec.ts`: typed BullMQ Job mock
- `encryption.spec.ts`: `undefined as any` → `undefined as unknown as string`
- `users/types.spec.ts`: same pattern
- `pipedrive-json-schema.spec.ts`: typed API client mock
- `pipedrive-connector.spec.ts`: typed schema mock
- Removed unnecessary file-level eslint-disable comments where possible

### Phase 4

- Bull worker dispatch: `Progress<any, any>` → `JobProgress` union type (defined in `union-types.ts`)
- YouTube connector factory: `ctx.connectorAccount as any` → extracted `ConnectorAccountRef` type in `connector-registry.ts`, changed constructor to accept it directly
- YouTube API client: 4x `catch (error: any)` → `catch (error: unknown)` with proper type narrowing
- YouTube API client: `transcriptResponse.data as any` → `as Blob`
- YouTube API client: removed 3 file-level eslint-disable comments (`no-unsafe-call`, `no-unsafe-assignment`, `no-unsafe-member-access`)
- YouTube connector: removed file-level `no-unsafe-argument` eslint-disable, added type guard for `additionalChannelIds`
- Notion-to-HTML transformer: `(block as any).audio` → `(block as Record<string, unknown>).audio as MediaValue`

### Phases 1-3

- Type guards: `any` → `unknown` with proper narrowing
- `TestTransformerResponse`: `value: any` → `unknown`
- Logging interceptor: `Observable<any>` → `Observable<unknown>`
- Wix blog error handling: `as any` → typed `WixErrorShape` interface
- Credential encryption: `Record<string, any>` → `Prisma.InputJsonValue`
- Audit log context: `Record<string, any>` → `Prisma.InputJsonObject`
- Data folder options: `Record<string, any>` → `Prisma.InputJsonValue`
- `Connector<string, any>` → `Connector` (uses defaults)
- `EncryptionService.encryptObject`: `Record<string, any>` → `object`
- Webflow schema: `(schema as any).properties` → `'properties' in schema`
- Mantine callbacks: `({ option }: any)` → `ComboboxLikeRenderOptionInput<ComboboxStringItem>`
- scratch-git list: `Promise<any[]>` → `Promise<RepoFileRef[]>`
