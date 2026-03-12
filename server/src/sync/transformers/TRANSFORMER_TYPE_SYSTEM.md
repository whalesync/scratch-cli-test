# Transformer Type System

## Overview

Each field transformer can declare the schema types it accepts (`paramType`) and produces (`returnType`). These declarations power a three-level validation pipeline that catches sync misconfigurations before data moves — giving meaningful errors to humans and, critically, to AI agents building or modifying syncs.

## Transformer Type Declarations

The `FieldTransformer` interface has two optional methods:

```ts
paramType?(options?: TransformerOptions): TSchema;  // what this transformer accepts as input
returnType?(inputType: TSchema, options?: TransformerOptions): TSchema;  // what it produces as output
```

- **`paramType`** — declares the expected input type. A transformer that only works on strings (e.g. `Slugify`, `HtmlToAirmark`) returns `Type.String()`. A transformer that works on anything returns `Type.Any()`.
- **`returnType`** — predicts the output type, optionally based on the input type or options. `StringToNumber` always returns `Type.Number()`. `EnsureType` returns the type declared in its options. `AutoConvert` returns the target type from its `targetType` option.
- **`Type.Any()`** (an empty JSON Schema `{}`) means "accepts everything" or "could be anything" — it is always compatible with any other type in validation.

## Three Levels of Validation

Validation runs from narrowest to broadest scope. Each level builds on the previous.

### Level 1 — Type Compatibility (`isTypeCompatible`)

**File:** `../schema-validator.ts`

The primitive question: *can a value of type A be assigned to a field of type B?*

Rules:
- `Any` on either side → always compatible
- Primitive equality: `string → string`, `number → number`, `boolean → boolean`, `object → object`
- Union destination: `string` is compatible with `string | null` (i.e. `anyOf([String, Null])`)

```ts
isTypeCompatible(Type.String(), Type.String())                        // true
isTypeCompatible(Type.Number(), Type.String())                        // false
isTypeCompatible(Type.String(), Type.Union([Type.String(), Type.Null()])) // true
isTypeCompatible(Type.Any(), Type.Number())                           // true
```

This is the building block used by the higher levels.

---

### Level 2 — Mapping Type Trace (`validate` / `traceMappingType`)

**File:** `./type-validator.ts`

For a single field mapping, simulates the type flowing through the transformer pipeline:

```
source field type → [transformer 1] → [transformer 2] → ... → predicted output type
```

Each transformer's `returnType` is called in sequence to predict the output type at each step. The final predicted type is then compared to the destination field type using `isTypeCompatible`.

If a transformer's `paramType` rejects the incoming type (by throwing), that step is flagged as an error and the trace stops.

`traceMappingType` returns the full trace — source type, each step with its output type or error, and the destination type. This is surfaced in the UI and returned to AI agents so they can understand exactly where a pipeline breaks down and why.

```
source: string
  → [Slugify]      → string   ✓
  → [destination]  string     ✓  compatible
```

```
source: string
  → [StringToNumber]  → number  ✓
  → [destination]     string    ✗  type mismatch: expected string, got number
```

---

### Level 3 — Full Schema Mapping Validation (`validateSchemaMapping`)

**File:** `../schema-validator.ts`

Validates all column mappings in a sync against the source and destination table schemas. For each mapping it checks that the source field exists, the destination field exists, and the base types are compatible.

This is the broadest check — it does not trace through transformer pipelines (use Level 2 for that), but it provides a fast structural scan of whether a mapping configuration makes sense at all.

---

## Why This Matters for AI Agents

AI agents building syncs need actionable feedback. A raw type error deep in a sync run is hard to act on. The type system is designed to surface errors **before execution** with enough context to self-correct:

- **Level 1** tells an agent whether two types are fundamentally compatible.
- **Level 2** tells an agent exactly which transformer in a pipeline is causing a type break, and what type that step received vs. what it expected.
- **Level 3** tells an agent which field mappings are structurally invalid across an entire table sync.

All three levels use the same JSON Schema vocabulary (`TSchema`), so the error messages reference types that are already present in the field schemas an agent has access to when constructing a sync.
