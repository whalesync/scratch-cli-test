import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { buildQuickBooksDefaultView } from './quickbooks-default-view';
import { QBO_SCHEMA_MAP } from './quickbooks-schemas';
import { ENTITY_CONFIG, QuickBooksEntityType } from './quickbooks-types';

/**
 * Build a BaseJsonTableSpec for a QuickBooks entity type using static schemas.
 *
 * Schemas are defined in quickbooks-schemas.ts based on Intuit's official API
 * documentation and the Airbyte QBO connector's field definitions.
 * All schemas have additionalProperties: true so undocumented fields pass through.
 */
export function buildQuickBooksJsonTableSpec(id: EntityId, entityType: QuickBooksEntityType): BaseJsonTableSpec {
  const config = ENTITY_CONFIG[entityType];
  const schema = QBO_SCHEMA_MAP[entityType];

  return {
    id,
    slug: entityType.toLowerCase(),
    name: config.displayName,
    schema,
    idColumnRemoteId: idPath('Id'),
    titleColumnRemoteId: [config.titleField],
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildQuickBooksDefaultView(schema, entityType),
  };
}
