/**
 * Shared types for GraphQL codegen plugins
 */

/**
 * Scalar type mapping configuration
 */
export interface ScalarMapping {
  /** The TypeBox type to use (e.g., 'string', 'number', 'boolean') */
  typeboxType: "string" | "number" | "boolean" | "unknown";
  /** Whether the scalar is nullable by default */
  nullable: boolean;
  /** Optional format for string types */
  format?: string;
}

/**
 * Field filter configuration
 */
export interface FieldFilterConfig {
  /** Fields to skip entirely */
  skipFields: Set<string>;
  /**
   * Fields to skip only within a specific GraphQL type, keyed by GraphQL type name → the field
   * names to drop from that type's generated schema AND query selection. Reach for this (rather
   * than {@link skipFields}) when the field name is legitimate on other types but must not be
   * pulled on this one — e.g. Linear's `Project.identifier` / `Project.previousIdentifiers`, which
   * the opt-in "Project IDs" workspace feature gates: selecting either one fails the ENTIRE
   * Projects pull on any workspace without that feature, while the identically named
   * `Issue.identifier` is always valid and the sync relies on it, so a blanket skip is wrong.
   */
  skipFieldsByType?: Record<string, Set<string>>;
  /** Connection fields to skip (paginated relationships) */
  skipConnections: Set<string>;
  /** Fields that require arguments and should be skipped */
  fieldsRequiringArgs: Set<string>;
  /**
   * Relation fields pulled as a narrow reference instead of a fully expanded nested object, keyed
   * by field name → the scalar leaves to select. Almost always `["id"]`: the id is the remote id
   * of the linked record, which is all a foreign key needs. Name a wider set only when the linked
   * type is NOT exposed as a table of its own, so nothing else can supply its human-readable
   * fields (Linear's `state` → `WorkflowState`).
   */
  referenceFieldSelections: Record<string, string[]>;
  /** Object types that should not be expanded */
  skipExpansionTypes: Set<string>;
}

/**
 * Entity configuration for code generation
 */
export interface EntityConfig {
  /** Internal entity type name (e.g., 'products', 'product_variants') */
  entityType: string;
  /** GraphQL type name (e.g., 'Product', 'ProductVariant') */
  graphqlType: string;
  /** Human-readable display name */
  displayName: string;
  /** Description for documentation */
  description: string;
  /** Whether this entity is read-only */
  readOnly: boolean;
  /** Column mappings for the UI */
  columns?: {
    slug?: string;
    title?: string[];
    mainContent?: string[];
  };
  /** Mutation configuration (if writable) */
  mutations?: {
    create?: string;
    update?: string;
    delete?: string;
    inputType?: string;
    /** Whether these are bulk mutations (e.g., productVariantsBulkCreate) */
    bulk?: boolean;
    /** Additional fields to mark as read-only (merged with auto-detected) */
    additionalReadOnlyFields?: string[];
    /** Fields to strip only on update (not create) */
    stripOnUpdateFields?: string[];
  };
  /** Parent entity for normalized child tables */
  parent?: {
    entityType: string;
    foreignKey: string;
    connectionField: string;
  };
  /** Metadata flags */
  metadata?: {
    plusOnly?: boolean;
  };
}

/**
 * Plugin configuration passed to all plugins
 */
export interface PluginConfig {
  /** Service name (e.g., 'shopify', 'linear') — used for schema $id prefixes and codegen command references */
  serviceName: string;
  /** Entity configurations */
  entities: EntityConfig[];
  /** Scalar type mappings */
  scalarMappings: Record<string, ScalarMapping>;
  /** Field filter configuration */
  fieldFilters: FieldFilterConfig;
  /** Maximum depth for nested field expansion */
  maxFieldDepth: number;
  /** Interface implementations for union/interface types */
  interfaceImplementations: Record<string, string[]>;
}

/**
 * Output from the TypeBox schema plugin
 */
export interface TypeBoxSchemaOutput {
  entityType: string;
  schemaCode: string;
  queryFields: string;
}

/**
 * Output from the mutations plugin
 */
export interface MutationOutput {
  entityType: string;
  mutations: {
    type: "create" | "update" | "delete";
    name: string;
    code: string;
  }[];
  readOnlyFields: string[];
  stripOnUpdateFields?: string[];
}
