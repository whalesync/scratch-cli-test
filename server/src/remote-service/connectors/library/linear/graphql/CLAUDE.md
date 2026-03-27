# Generated Code - Do Not Edit

This directory contains **auto-generated code** from the Linear GraphQL codegen system.

## Important

- **DO NOT** edit files in this directory directly
- **DO NOT** add new files to this directory manually
- All changes will be **overwritten** when codegen is run

## How to Regenerate

To regenerate these files, run from the tools/graphql-codegen directory:

```bash
LINEAR_CODEGEN_API_KEY=lin_api_xxx yarn codegen:linear
```

## How to Make Changes

### To modify schemas or mutations:

1. Edit the entity configuration in `tools/graphql-codegen/src/linear/config.ts`
2. Re-run the codegen command above

### To add new entities:

1. Add entity config to `LINEAR_ENTITIES` in `tools/graphql-codegen/src/linear/config.ts`
2. Re-run the codegen command

### To change field filtering or mappings:

1. Edit `LINEAR_FIELD_FILTERS` or `LINEAR_SCALAR_MAPPINGS` in `tools/graphql-codegen/src/linear/config.ts`
2. Re-run the codegen command

## Source Files

- Codegen script: `tools/graphql-codegen/src/linear/run.ts`
- Entity configuration: `tools/graphql-codegen/src/linear/config.ts`
- TypeBox plugin: `tools/graphql-codegen/src/plugins/typebox-plugin.ts`
- Mutations plugin: `tools/graphql-codegen/src/plugins/mutations-plugin.ts`

## Directory Structure

- `schemas/` - TypeBox schemas and query field selections per entity
- `mutations/` - GraphQL mutation strings and read-only field sets
- `metadata.ts` - Generation timestamp
- `index.ts` - Re-exports all generated code
