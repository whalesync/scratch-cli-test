import type { CreateFieldSpec, CreateSchemaTablesDto } from '@spinner/shared-types';
import {
  NormalizedCreateSchemaPlan,
  NormalizedCreateTablePlan,
} from 'src/remote-service/connectors/schema-creation.types';

/**
 * Turn a validated create-tables request into an execution plan: tables ordered
 * so that a foreignKey to a sibling table is created AFTER that sibling, with
 * cycle-closing and self-referential foreignKey fields pulled out into
 * `deferredFkFields` (the server adds those via `Connector.createFields` once
 * every table exists).
 *
 * This is a pure function — it computes ordering and the deferred split. It does
 * NOT substitute `{ ref }` foreignKey targets for real remote ids; those ids
 * don't exist until the tables are actually created, so the service performs
 * that substitution at dispatch time (the later connector pass).
 *
 * The request is assumed already validated (every `{ ref }` target resolves to a
 * table in the request — enforced by the zod schema), so this never throws.
 */
export function normalizeCreateSchema(request: CreateSchemaTablesDto): NormalizedCreateSchemaPlan {
  // Per-table working state: fields kept for the createTable call vs deferred.
  // Self-referential foreignKeys start deferred (the table's own remote id isn't
  // known until it's created).
  const working = request.tables.map((table) => {
    const keptFields: CreateFieldSpec[] = [];
    const deferredFkFields: CreateFieldSpec[] = [];
    for (const field of table.fields) {
      if (isSelfReferentialForeignKey(field, table.ref)) {
        deferredFkFields.push(field);
      } else {
        keptFields.push(field);
      }
    }
    return { table, keptFields, deferredFkFields };
  });

  const orderedRefs = new Set<string>();
  const tablesInCreationOrder: NormalizedCreateTablePlan[] = [];
  const pending = [...working];

  /** Cross-table foreignKey targets among a table's kept fields not yet ordered. */
  const unmetDependencyCount = (entry: (typeof working)[number]): number => {
    let count = 0;
    for (const field of entry.keptFields) {
      const targetRef = crossTableForeignKeyRef(field, entry.table.ref);
      if (targetRef !== null && !orderedRefs.has(targetRef)) count += 1;
    }
    return count;
  };

  while (pending.length > 0) {
    let pickedIndex = pending.findIndex((entry) => unmetDependencyCount(entry) === 0);

    if (pickedIndex === -1) {
      // A dependency cycle remains. Break it by deferring the cycle-closing
      // foreignKey fields of the first pending table (those pointing at tables
      // not yet ordered), which makes that table immediately orderable.
      const entry = pending[0];
      const stillKept: CreateFieldSpec[] = [];
      for (const field of entry.keptFields) {
        const targetRef = crossTableForeignKeyRef(field, entry.table.ref);
        if (targetRef !== null && !orderedRefs.has(targetRef)) {
          entry.deferredFkFields.push(field);
        } else {
          stillKept.push(field);
        }
      }
      entry.keptFields = stillKept;
      pickedIndex = 0;
    }

    const [picked] = pending.splice(pickedIndex, 1);
    orderedRefs.add(picked.table.ref);
    tablesInCreationOrder.push({
      remoteParentId: request.remoteParentId,
      newParentName: request.newParentName,
      ref: picked.table.ref,
      name: picked.table.name,
      fields: picked.keptFields,
      deferredFkFields: picked.deferredFkFields,
    });
  }

  return { tablesInCreationOrder };
}

/** True when `field` is a foreignKey whose `{ ref }` target is the table itself. */
function isSelfReferentialForeignKey(field: CreateFieldSpec, ownRef: string): boolean {
  const fieldType = field.fieldType;
  return fieldType.kind === 'foreignKey' && 'ref' in fieldType.target && fieldType.target.ref === ownRef;
}

/**
 * If `field` is a foreignKey pointing at a DIFFERENT table in the request (by
 * `ref`), return that target ref; otherwise null. (Targets that are an existing
 * remote table id, or self-references, create no ordering dependency.)
 */
function crossTableForeignKeyRef(field: CreateFieldSpec, ownRef: string): string | null {
  const fieldType = field.fieldType;
  if (fieldType.kind === 'foreignKey' && 'ref' in fieldType.target && fieldType.target.ref !== ownRef) {
    return fieldType.target.ref;
  }
  return null;
}
