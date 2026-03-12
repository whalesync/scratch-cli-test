# Type Validation & Transformation

This document outlines the system for validating type safety as values travel through transformers from source schema to destination schema, specifically to detect and warn about mismatches.

## [DONE] Completed Infrastructure

### 1. `FieldTransformer` Interface Update

#### [DONE] [transformer.types.ts](file:///Users/ijd/repos/spinner/server/src/sync/transformers/transformer.types.ts)

Added the optional `outputType` function to the `FieldTransformer` interface to allow transformers to predict their effect on field schemas.

### 2. Transformer Implementation

#### [DONE] [ensure-type.transformer.ts](file:///Users/ijd/repos/spinner/server/src/sync/transformers/implementations/ensure-type.transformer.ts)

Implemented `outputType` for the `EnsureType` transformer. It now returns the predicted `TSchema` (string, number, boolean, object, or array) based on the `expectedType` option.

### 3. Pipeline Tracing & Validation Logic

#### [DONE] [type-validator.ts](file:///Users/ijd/repos/spinner/server/src/sync/transformers/type-validator.ts)

Implemented the `validate` function which:

- Extracts initial types from the `sourceSchema`.
- Traces the type through the mapping's transformer pipeline using `outputType`.
- Compares the final predicted type with the `destSchema` type using strict structural equality (ignoring styling metadata like titles/descriptions).
- Returns a list of type mismatch warnings.

### 4. Verification

#### [DONE] [type-validation.spec.ts](file:///Users/ijd/repos/spinner/server/src/sync/transformers/__integration_tests__/type-validation.spec.ts)

Created integration tests verifying:

- No warnings on matching schemas.
- Correct mismatch detection for incompatible raw types.
- Correct type resolution through `EnsureType` transforms.

---

## [TODO] Remaining Work

### 1. ~~Support More Transformers~~ [DONE]

- Implemented `outputType` for:
  - **StringToNumber**: Returns `Type.Number()`.
  - **AutoConvert**: Returns type from `targetType` option (`string`, `number`, `integer`, `boolean`, `array`), or `Type.Any()` when unknown.
  - **WebflowOptionIdToValue**: Returns `Type.String()`.

### 2. System-wide Integration

- **Backend**: Update `SyncService` to call `validate()` when saving or checking a sync configuration. Store or return these warnings to the user.
- **Frontend**:
  - Call the validation logic (or have the backend return it) in the Sync Editor.
  - Display non-blocking UI warnings in the field mapping list when a type mismatch is detected.

### 3. Edge Case Handling

- Narrow down `Type.Object({})` and `Type.Array(Type.Any())` predictions in `EnsureType` if more schema context is available.
- Handle `Union` types more gracefully during pipeline tracing (currently depends on strict equality).
