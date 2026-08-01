/**
 * Types for the Sanity Content Lake HTTP API.
 *
 * Sanity's backend ("Content Lake") is a schemaless JSON document store. Every document
 * carries system fields (`_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`) plus arbitrary
 * user-defined fields. Reads go through GROQ queries; writes go through the Mutation API.
 *
 * API docs: https://www.sanity.io/docs/http-reference
 */

/** A project as returned by the management API (`GET https://api.sanity.io/.../projects`). */
export interface SanityProject {
  id: string;
  displayName: string;
  organizationId?: string | null;
  studioHost?: string | null;
}

/** A dataset as returned by `GET .../projects/{projectId}/datasets`. */
export interface SanityDataset {
  name: string;
  /** 'public' datasets are readable without a token; 'private' require one. */
  aclMode?: string;
}

/**
 * The transport envelope around a GROQ query result
 * (`GET|POST https://{projectId}.api.sanity.io/{version}/data/query/{dataset}`).
 * Only `result` is the data; the rest is stripped per the Connector Prime Directive.
 */
export interface SanityQueryResponse<TResult> {
  query?: string;
  result: TResult;
  ms?: number;
  syncTags?: string[];
}

/**
 * A Content Lake document. The system fields below are guaranteed by the service;
 * every other field is user-defined (the store is schemaless).
 */
export interface SanityDocument {
  _id: string;
  _type: string;
  _rev?: string;
  _createdAt?: string;
  _updatedAt?: string;
  [userDefinedField: string]: unknown;
}

/**
 * A deployed Studio schema system document, stored into the dataset by
 * `sanity schema deploy` with id `_.schemas.<workspaceName>`.
 *
 * Live observations (project hkcx2dra, 2026-07-31): `_type` is `"system.schema"`
 * (docs historically say `sanity.workspace.schema`), and `schema` is a JSON **string**
 * serializing the Studio types — see `sanity-deployed-schema.ts` for the parsed shape.
 * System documents (`_.`-prefixed ids) are reachable via `*[_id in path("_.schemas.**")]`
 * even at `perspective=published`.
 */
export interface SanityDeployedSchemaDocument {
  _id: string;
  _type: string;
  workspace?: { name?: string; title?: string };
  /** JSON string live; tolerate an already-parsed array. */
  schema?: unknown;
  version?: string;
}

/**
 * One mutation in a Mutation API transaction
 * (`POST .../data/mutate/{dataset}`). A request carries an array of these and
 * they are applied atomically.
 */
export type SanityMutation =
  | { create: Record<string, unknown> }
  | { createOrReplace: Record<string, unknown> }
  | { createIfNotExists: Record<string, unknown> }
  | { patch: { id: string; set?: Record<string, unknown>; unset?: string[] } }
  | { delete: { id: string } };

/** The Mutation API response. `document` is present only when `returnDocuments=true`. */
export interface SanityMutationResponse {
  transactionId: string;
  results: { id: string; operation?: string; document?: SanityDocument }[];
}

/** The error body shape the Sanity APIs return, e.g. `{ error: { description, type } }`. */
export interface SanityErrorResponseBody {
  error?: {
    description?: string;
    type?: string;
  };
  message?: string;
}
