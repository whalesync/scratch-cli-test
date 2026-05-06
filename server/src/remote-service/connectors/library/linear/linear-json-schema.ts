/**
 * Linear JSON Schema Builder
 *
 * Builds TypeBox schemas for Linear entity types using generated schemas.
 */

import { type TSchema } from '@sinclair/typebox';
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

  return spec;
}
