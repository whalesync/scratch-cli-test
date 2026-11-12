# Generated Code - Do Not Edit

This directory contains **auto-generated code** from the Shopify GraphQL codegen system.

## Important

- **DO NOT** edit files in this directory directly
- **DO NOT** add new files to this directory manually
- All changes will be **overwritten** when codegen is run

## How to Regenerate

To regenerate these files, run from the tools/graphql-codegen directory:

```bash
yarn codegen:shopify
```

With no environment variables this introspects Shopify's public Admin API schema proxy, so no
store or token is needed. To introspect a specific store instead, set both
`SHOPIFY_CODEGEN_SHOP` and `SHOPIFY_CODEGEN_TOKEN`.

## How to Make Changes

### To modify schemas or mutations:

1. Edit the entity configuration in `tools/graphql-codegen/src/shopify/config.ts`
2. Re-run the codegen command above

### To add new entities:

1. Add entity config to `SHOPIFY_ENTITIES` in `tools/graphql-codegen/src/shopify/config.ts`
2. Re-run the codegen command

### To change field filtering or mappings:

1. Edit `SHOPIFY_FIELD_FILTERS` or `SHOPIFY_SCALAR_MAPPINGS` in `tools/graphql-codegen/src/shopify/config.ts`
2. Re-run the codegen command

## Source Files

- Codegen script: `tools/graphql-codegen/src/shopify/run.ts`
- Entity configuration: `tools/graphql-codegen/src/shopify/config.ts`
- TypeBox plugin: `tools/graphql-codegen/src/plugins/typebox-plugin.ts`
- Mutations plugin: `tools/graphql-codegen/src/plugins/mutations-plugin.ts`

## Directory Structure

- `schemas/` - TypeBox schemas and query field selections per entity
- `mutations/` - GraphQL mutation strings and read-only field sets
- `metadata.ts` - API version and generation timestamp
- `index.ts` - Re-exports all generated code
