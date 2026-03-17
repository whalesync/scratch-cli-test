# Connector Metadata API

## Goal

Eliminate `client/src/service-naming-conventions.ts` as a connector-specific touchpoint. Each connector class declares its own display metadata as a static property, and a new public API endpoint serves it to the client.

## Server: Static metadata on each connector class

Add a `ConnectorMetadata` interface to shared-types and a static `metadata` property on each connector class.

```typescript
export interface ConnectorMetadata {
  displayName: string;
  table: string;
  tables: string;
  record: string;
  records: string;
  base: string | null;
  bases: string | null;
  logo: string;
  visible: boolean;
  pushOperationName: string;
  pullOperationName: string;
  oauth?: {
    label: string;
    privateLabel?: string;
  };
}
```

A `connectorMetadata()` helper provides defaults so connectors only override what differs:

```typescript
static readonly metadata = connectorMetadata({
  displayName: 'Webflow',
  table: 'collection', tables: 'collections',
  record: 'item', records: 'items',
});
```

Defaults: `table`/`record` = "table"/"record", `base` = null, `logo` = `<lowercase-service>.svg`, `visible` = true, `pushOperationName` = "Publish", `pullOperationName` = "Download", no `oauth`.

### Visibility

| Connector   | visible |
| ----------- | ------- |
| Airtable    | true    |
| Webflow     | true    |
| Notion      | true    |
| WordPress   | true    |
| YouTube     | false   |
| Wix Blog    | true    |
| PostgreSQL  | false   |
| Audienceful | true    |
| Moco        | true    |
| Shopify     | true    |
| Pipedrive   | true    |
| Supabase    | true    |
| QuickBooks  | true    |

## Server: New endpoint

- **Route:** `GET /connectors/metadata`
- **Auth:** Public (no auth guard)
- **Controller:** `ConnectorsMetadataController` in the remote-service module
- **Response:** `Record<Service, ConnectorMetadata>`

The controller reads metadata from `CONNECTOR_MAP` (which already references all connector classes) and returns it as JSON.

## Client: Fetch and consume

- New SWR hook `useConnectorsMetadata()` fetches `GET /connectors/metadata`
- Replace all imports of `ServiceNamingConventions` helpers with the hook
- Delete `client/src/service-naming-conventions.ts`
- Delete `INTERNAL_SERVICES` from `connector-accounts.ts` — replaced by `visible` flag
- Derive OAuth support from `metadata.oauth` field presence — delete `OAuthService` type from `client/src/types/oauth.ts`

## Files touched

### Server (new)

- `packages/shared-types/src/connector-metadata.ts` — `ConnectorMetadata` interface + `connectorMetadata()` helper
- `server/src/remote-service/connectors/connectors-metadata.controller.ts` — the endpoint

### Server (modified)

- Each connector class in `server/src/remote-service/connectors/library/*/` — add `static readonly metadata`
- `server/src/remote-service/connectors/display-names.ts` — simplify to use `metadata.displayName`
- `server/src/remote-service/remote-service.module.ts` — register new controller

### Client (new)

- `client/src/lib/api/connectors-metadata.ts` — API fetch function
- `client/src/hooks/use-connectors-metadata.ts` — SWR hook

### Client (modified)

- All files importing from `service-naming-conventions.ts` — switch to hook
- `client/src/lib/api/keys.ts` — add SWR key

### Client (deleted)

- `client/src/service-naming-conventions.ts`
- `INTERNAL_SERVICES` from `client/src/types/server-entities/connector-accounts.ts`
- `OAuthService` type from `client/src/types/oauth.ts`

## Out of scope

- CLI credential field definitions
- `connectors.service.ts` switch statement
- Prisma schema / migrations
- OAuth provider registration
