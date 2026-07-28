/**
 * Linear Codegen Configuration
 *
 * Entity configurations, field filters, and mappings specific to
 * the Linear GraphQL API.
 */

import {
  EntityConfig,
  FieldFilterConfig,
  PluginConfig,
  ScalarMapping,
} from "../types";

// =============================================================================
// SCALAR MAPPINGS
// =============================================================================

export const LINEAR_SCALAR_MAPPINGS: Record<string, ScalarMapping> = {
  String: { typeboxType: "string", nullable: true },
  Int: { typeboxType: "number", nullable: true },
  Float: { typeboxType: "number", nullable: true },
  Boolean: { typeboxType: "boolean", nullable: true },
  ID: { typeboxType: "string", nullable: false },
  DateTime: { typeboxType: "string", nullable: true, format: "date-time" },
  // Calendar date with no time component (Issue `dueDate`, Project `startDate`/`targetDate`).
  // Without `format` these generate as bare strings, and every date-detection path downstream —
  // the default view's `mapType`, and through it the Live Export plan — types them as text
  // rather than a real date column (DEV-11026). `linear-json-schema.ts` annotates the top-level
  // fields at runtime so the fix holds until the schemas are next regenerated; regenerating makes
  // that annotation redundant and additionally covers the nested copies.
  TimelessDate: { typeboxType: "string", nullable: true, format: "date" },
  JSON: { typeboxType: "unknown", nullable: true },
  JSONObject: { typeboxType: "unknown", nullable: true },
  UUID: { typeboxType: "string", nullable: true },
};

// =============================================================================
// FIELD FILTERS
// =============================================================================

export const LINEAR_FIELD_FILTERS: FieldFilterConfig = {
  skipFields: new Set([
    // Internal/deprecated fields
    "botActor",
    "externalUserCreator",
    "integrationsSettings",
    "integrationSourceType",

    // Subscription/billing fields
    "subscription",

    // Sensitive fields
    "archivedModelSyncStatus",
    "triagedAt",

    // Internal editor state blobs (ProseMirror serialized state)
    "descriptionState",
    "contentState",
  ]),

  skipConnections: new Set([
    // Large connection fields - too deep for schema generation
    "issues",
    "comments",
    "history",
    "relations",
    "inverseRelations",
    "subscribers",
    "children",
    "attachments",
    "projectUpdates",
    "projectMilestones",
    "members",
    "teams",
    "labels",
    "documents",
    "integrationsSettings",
  ]),

  fieldsRequiringArgs: new Set([
    // Fields that require arguments
    "notification",
    "issueSearch",
  ]),

  referenceFieldSelections: {
    // Each of these links to a Linear entity we expose as its own table, so the id — the remote id
    // of the linked record — is all the default view's foreign key needs (DEV-11023).
    creator: ["id"],
    assignee: ["id"],
    team: ["id"],
    project: ["id"],
    cycle: ["id"],
    parent: ["id"],
    snoozedBy: ["id"],
    favorite: ["id"],
    // `state` is the exception: `WorkflowState` is NOT one of the six entity types we expose, so
    // there is no Workflow States table for a foreign key to resolve against and no other way for
    // the human-readable status to reach a destination. Selecting only `{ id }` exported every
    // issue's status as an opaque uuid (DEV-11024), so pull the displayable fields with it.
    state: ["id", "name", "type", "color", "position", "description"],
  },

  skipExpansionTypes: new Set([
    // Types that should not be expanded in schemas
    "Organization",
    "Notification",
    "Integration",
    "Webhook",
    "WorkflowState",
  ]),
};

// =============================================================================
// ENTITY CONFIGURATIONS
// =============================================================================

export const LINEAR_ENTITIES: EntityConfig[] = [
  // ============= Writable Entities =============
  {
    entityType: "issues",
    graphqlType: "Issue",
    displayName: "Issues",
    description: "Project issues and tasks",
    readOnly: false,
    columns: {
      slug: "identifier",
      title: ["title"],
      mainContent: ["issues", "description"],
    },
    mutations: {
      create: "issueCreate",
      update: "issueUpdate",
      delete: "issueDelete",
      inputType: "IssueCreateInput",
    },
  },
  {
    entityType: "projects",
    graphqlType: "Project",
    displayName: "Projects",
    description: "Projects for organizing issues",
    readOnly: false,
    columns: {
      slug: "slugId",
      title: ["name"],
      mainContent: ["projects", "description"],
    },
    mutations: {
      create: "projectCreate",
      update: "projectUpdate",
      delete: "projectDelete",
      inputType: "ProjectCreateInput",
    },
  },

  // ============= Read-Only Entities =============
  {
    entityType: "teams",
    graphqlType: "Team",
    displayName: "Teams",
    description: "Workspace teams",
    readOnly: true,
    columns: {
      slug: "key",
      title: ["name"],
    },
  },
  {
    entityType: "users",
    graphqlType: "User",
    displayName: "Users",
    description: "Workspace members",
    readOnly: true,
    columns: {
      title: ["name"],
    },
  },
  {
    entityType: "labels",
    graphqlType: "IssueLabel",
    displayName: "Labels",
    description: "Issue labels",
    readOnly: true,
    columns: {
      title: ["name"],
    },
  },
  {
    entityType: "cycles",
    graphqlType: "Cycle",
    displayName: "Cycles",
    description: "Team development cycles",
    readOnly: true,
    columns: {
      slug: "number",
      // `name`, not `number`: the title column also designates a table's PRIMARY field, and Notion
      // only accepts a text primary — a number-typed one aborted the whole atomic create (DEV-11025).
      // `number` stays the slug so record filenames still fall back to it. `linear-json-schema.ts`
      // applies the same override at runtime until the schemas are next regenerated.
      title: ["name"],
    },
  },
];

// =============================================================================
// CONFIG BUILDERS
// =============================================================================

/**
 * Create full plugin config for Linear codegen
 */
export function createLinearPluginConfig(): PluginConfig {
  return {
    serviceName: "linear",
    entities: LINEAR_ENTITIES,
    scalarMappings: LINEAR_SCALAR_MAPPINGS,
    fieldFilters: LINEAR_FIELD_FILTERS,
    maxFieldDepth: 2,
    interfaceImplementations: {},
  };
}
