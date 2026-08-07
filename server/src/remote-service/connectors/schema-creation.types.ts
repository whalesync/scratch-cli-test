import type { CreateFieldSpec } from '@spinner/shared-types';

/**
 * Server↔connector contract types for create-schema (DEV-10378).
 *
 * The schema-builder service produces these *normalized* plans; a connector
 * consumes them. They live here (next to the other connector contract types)
 * rather than in schema-builder so that `connector.ts` can reference them
 * without a connectors→schema-builder import cycle. They are NOT wire types —
 * nothing here crosses the REST boundary — so they do not belong in
 * `@spinner/shared-types`.
 */

/**
 * A {@link CreateFieldSpec} whose foreignKey `target` (if any) has been resolved
 * by the server to a concrete `{ existingRemoteTableId }` — never an in-request
 * `{ ref }`. The type is structurally identical to `CreateFieldSpec`; the
 * "resolved" guarantee is upheld by the normalizer, so connectors may assume a
 * foreignKey field's target is always `existingRemoteTableId`.
 */
export type ResolvedCreateFieldSpec = CreateFieldSpec;

/**
 * Plan for creating one table and its fields. Handed to `Connector.createTable`.
 * Tables are created in dependency order so that a foreignKey to a sibling table
 * has already been resolved to that sibling's new remote id by the time this
 * table is created. Fields that form a dependency *cycle* across tables are
 * pulled out into `deferredFkFields` and added via `Connector.createFields`
 * after every table exists.
 */
export interface NormalizedCreateTablePlan {
  /** Remote base/parent under which to create (connector-interpreted). */
  remoteParentId?: string[];
  /**
   * Suggested display name for a brand-new parent container the connector must
   * create for this batch (e.g. a Google Sheets spreadsheet or an Airtable base).
   * Copied verbatim from the request onto every table plan in the batch so the
   * connector can name the parent it lazily creates on the first table. Connectors
   * that create into an existing parent ignore it; the connector supplies its own
   * default when this is absent.
   */
  newParentName?: string;
  /** The caller-assigned correlation handle from the request. */
  ref: string;
  name: string;
  /** Created together with the table. The primary field carries `isPrimary`. */
  fields: ResolvedCreateFieldSpec[];
  /** Cyclic foreignKey fields added via createFields once all tables exist. */
  deferredFkFields: ResolvedCreateFieldSpec[];
}

/** Plan for adding fields to an already-existing remote table. */
export interface NormalizedCreateFieldsPlan {
  remoteTableId: string[];
  fields: ResolvedCreateFieldSpec[];
}

/** The whole create-tables request, normalized and ready to execute. */
export interface NormalizedCreateSchemaPlan {
  /** Tables topologically sorted by foreignKey dependency. */
  tablesInCreationOrder: NormalizedCreateTablePlan[];
}
