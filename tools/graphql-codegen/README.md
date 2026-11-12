# GraphQL Codegen Framework

A tool for generating TypeBox schemas and mutation code from GraphQL APIs via introspection.

## Quick Start (Shopify)

```bash
# Run codegen against Shopify's public schema proxy (no store needed)
yarn codegen:shopify

# Or introspect a specific store
SHOPIFY_CODEGEN_SHOP=your-store-name SHOPIFY_CODEGEN_TOKEN=shpat_xxxxx yarn codegen:shopify
```

This generates TypeBox schemas, mutations, and query fields to:
`server/src/remote-service/connectors/library/shopify/graphql/`

See [`src/shopify/run.ts`](./src/shopify/run.ts) for the full implementation.

With no environment variables, the schema comes from Shopify's public Admin API schema proxy
(`https://shopify.dev/admin-graphql-direct-proxy/<version>`, what shopify.dev's GraphiQL explorer
uses), so no store or token is needed. The API version is pinned in `src/shopify/run.ts`; keep it
on a version Shopify still supports.

### Customers and Orders

Customers, Orders, Order Line Items, and Order Shipping Lines are on every Shopify plan, not just
Plus. Their names, emails, phone numbers, and addresses are Shopify "protected customer data": a
merchant's own custom app reads them with the `read_customers` scope, and needs `read_all_orders`
to see orders older than 60 days.

## Overview

This framework introspects a GraphQL API and generates:

- **TypeBox schemas** - Type-safe runtime validation schemas
- **Query field selections** - GraphQL field selection strings for fetching entities
- **Mutation code** - Create/update/delete mutation strings with input type handling
- **Metadata** - API version and generation timestamps

In theory, this tool is service-agnostic and can be adapted for any GraphQL API by providing service-specific configuration.

## Architecture

```
codegen/graphql/
├── README.md             # This file
├── types.ts              # Configuration interfaces and introspection types
├── introspector.ts       # GraphQL schema introspection via queries
├── typebox-generator.ts  # Converts introspected schemas to TypeBox code
├── mutation-generator.ts # Generates mutation strings from introspected mutations
├── index.ts              # Re-exports
└── shopify/              # Shopify implementation (reference example)
    ├── config.ts         # Entity configs, field filters, Plus-only handling
    └── run.ts            # Codegen entry point (yarn codegen:shopify)
```

## Adding a New Service

To add codegen for a new GraphQL service, use `shopify/` as a reference implementation.
