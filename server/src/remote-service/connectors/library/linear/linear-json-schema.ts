/**
 * Linear JSON Schema Builder
 *
 * Builds TypeBox schemas for Linear entity types using generated schemas.
 */

import { type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import {
  CyclesSchema,
  ENTITY_REGISTRY,
  type EntityType,
  IssuesSchema,
  LabelsSchema,
  ProjectsSchema,
  TeamsSchema,
  UsersSchema,
} from './graphql';
import { buildLinearDefaultView } from './linear-default-view';

/**
 * Map entity types to their generated TypeBox schemas.
 */
const SCHEMA_MAP: Record<EntityType, TSchema> = {
  issues: IssuesSchema,
  projects: ProjectsSchema,
  teams: TeamsSchema,
  users: UsersSchema,
  labels: LabelsSchema,
  cycles: CyclesSchema,
};

/**
 * Every Linear entity (Issue, Project, Team, User, IssueLabel, Cycle) exposes a
 * server-side `updatedAt` system field. Annotate it as the last-modified field
 * on each entity schema so the auto-detect layer (`findLastModifiedFieldName`)
 * and the client's last-modified-field picker surface it. The connector itself
 * hardcodes `updatedAt` for incremental pulls (it is guaranteed universal), the
 * same way Notion annotates `last_edited_time` for the UI even though its
 * connector hardcodes that field. The generated schema files apply
 * `X_SCRATCH_READONLY` to these same singletons by post-hoc mutation; this is
 * the equivalent additive annotation kept out of the generated (do-not-edit)
 * code.
 */
for (const schema of Object.values(SCHEMA_MAP)) {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (props?.updatedAt) {
    props.updatedAt[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }
}

/**
 * Annotate body-of-text fields as Markdown. Linear renders these via its own
 * Markdown editor; the desktop preview's rich-text toggle keys off
 * `contentMediaType` to pick a renderer. Like the `updatedAt` annotation
 * above, this is additive metadata kept out of the generated (do-not-edit)
 * schema files.
 */
const issueProps = (IssuesSchema as { properties: Record<string, Record<string, unknown>> }).properties;
const projectProps = (ProjectsSchema as { properties: Record<string, Record<string, unknown>> }).properties;
issueProps.description.contentMediaType = 'text/markdown';
projectProps.description.contentMediaType = 'text/markdown';
projectProps.content.contentMediaType = 'text/markdown';

/**
 * Build a BaseJsonTableSpec for a Linear entity type.
 */
export function buildLinearJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const entityType = id.wsId as EntityType;
  const config = ENTITY_REGISTRY[entityType];

  if (!config) {
    throw new Error(`Unknown Linear entity type: ${entityType}`);
  }

  const schema = SCHEMA_MAP[entityType];
  if (!schema) {
    throw new Error(`Schema not found for entity type: ${entityType}`);
  }

  const spec: BaseJsonTableSpec = {
    id,
    slug: entityType,
    name: config.displayName,
    schema,
    idColumnRemoteId: idPath('id'),
    generatedAt: new Date().toISOString(),
  };

  const columns = config.columns as
    | { slug?: string; title?: readonly string[]; mainContent?: readonly string[] }
    | undefined;
  if (columns?.slug) {
    spec.slugFieldPath = columns.slug;
  }
  if (columns?.title) {
    spec.titleColumnRemoteId = [...columns.title];
  }
  if (columns?.mainContent) {
    spec.mainContentColumnRemoteId = [...columns.mainContent];
  }

  spec.defaultView = buildLinearDefaultView(schema, entityType);

  return spec;
}
