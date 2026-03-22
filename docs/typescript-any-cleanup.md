# TypeScript `any` Cleanup Plan

## Motivation

We audited all `any` usage across the codebase and cleaned up the easy wins. This doc tracks what's left and why, so we can chip away at it over time.

## Current State (after Phase 1-4 cleanup)

### Production code: mostly clean

The remaining `any` in non-test production code falls into a few categories:

#### 1. Generic type constraints in `JobDefinitionBuilder` (~5 occurrences)

**File:** `server/src/worker/jobs/base-types.ts`

`JobHandlerBuilder<TDefinition extends JobDefinitionBuilder<any, any, any, any, any>>` uses `any` in the `extends` clause because TypeScript's `infer` pattern requires `any` constraints to match all possible instantiations. `unknown` is too restrictive here.

**Fix:** This is a TypeScript language limitation. No fix needed — this is the correct pattern.

#### 2. Notion SDK interop (~30+ occurrences across 4 files)

**Files:**

- `server/src/remote-service/connectors/library/notion/conversion/notion-block-diff.ts`
- `server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts`
- `server/src/remote-service/connectors/library/notion/conversion/notion-rich-text-conversion.ts`
- `server/src/remote-service/connectors/library/notion/conversion/json-cycle.ts`

The Notion SDK has 50+ block types with deeply nested discriminated unions. The conversion code accesses block-specific properties that vary per type (e.g., `paragraph.rich_text`, `heading_1.rich_text`, `image.file.url`). Properly typing this would require exhaustive pattern matching over every block type.

These files have file-level `eslint-disable` comments for `no-unsafe-*` rules.

**Fix:** Create a type-safe Notion block accessor layer with exhaustive discriminated union handling. This is a large, standalone refactor — probably 2-3 days of work.

#### 3. `json-cycle.ts` — borrowed third-party code

**File:** `server/src/remote-service/connectors/library/notion/conversion/json-cycle.ts`

Crockford's JSON cycle detection library, copied verbatim. Uses `any` throughout because it operates on arbitrary JSON-like values.

**Fix:** Not worth rewriting. The `/* eslint-disable */` comment documents this.

### Test code: ~80+ occurrences

Test files use `as any` extensively for partial mocks. The most common patterns:

- `mockService = { someMethod: jest.fn() } as any` — partial mock of a service
- `MOCK_WORKBOOK as any` — partial workbook object missing optional fields
- `(service as any).stripe` — accessing private members for test setup

**Files with most test `any`:**

- `server/src/sync/__tests__/sync.service.spec.ts` (~40 occurrences)
- `server/src/payment/stripe-payment.service.spec.ts` (~15 occurrences)
- `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.spec.ts` (~5 occurrences)

**Fix:** Replace `as any` with `as unknown as FooService` for type safety, or create test factories/builders that produce properly-typed partial objects. Low risk, but tedious. Good candidate for gradual cleanup.

## Phase 5: Enable the ESLint rule

Once the remaining production code `any` usages are addressed (or have targeted `eslint-disable` comments), enable `@typescript-eslint/no-explicit-any` in `server/eslint.config.mjs`:

```js
// Change from:
'@typescript-eslint/no-explicit-any': 'off',
// To:
'@typescript-eslint/no-explicit-any': 'warn',
// And eventually:
'@typescript-eslint/no-explicit-any': 'error',
```

The client ESLint config (`eslint-config-next/typescript`) doesn't enable this rule either — consider adding it there too.

## What we already fixed (Phases 1-4)

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
