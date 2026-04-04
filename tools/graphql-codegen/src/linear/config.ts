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
  TimelessDate: { typeboxType: "string", nullable: true },
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

  referenceOnlyFields: new Set([
    // Fields that should only include { id } in queries
    "creator",
    "assignee",
    "team",
    "project",
    "cycle",
    "parent",
    "state",
    "snoozedBy",
    "favorite",
  ]),

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
