import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { linkedTableIdCandidateTokensForRemoteTableId } from 'src/schema-builder/foreign-key-linked-table-id';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { EntityId } from '../../../types';
import { buildQuickBooksDefaultView } from '../quickbooks-default-view';
import { buildQuickBooksJsonTableSpec } from '../quickbooks-json-schema';
import { QBO_SCHEMA_MAP } from '../quickbooks-schemas';
import { ENTITY_TYPES, QuickBooksEntityType } from '../quickbooks-types';

function entityId(entityType: string): EntityId {
  return { wsId: entityType.toLowerCase(), remoteId: [entityType] };
}

/**
 * Every `linkedTableId` in a QuickBooks schema, with the path it was found at, walked
 * recursively so the annotations nested under `Line[]` are covered too.
 */
function collectLinkedTableIds(schema: unknown, path = ''): { path: string; linkedTableId: string }[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const found: { path: string; linkedTableId: string }[] = [];

  const foreignKey = node[X_SCRATCH_FOREIGN_KEY_OPTIONS] as { linkedTableId?: unknown } | undefined;
  if (typeof foreignKey?.linkedTableId === 'string') {
    found.push({ path, linkedTableId: foreignKey.linkedTableId });
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === X_SCRATCH_FOREIGN_KEY_OPTIONS) continue;
    found.push(...collectLinkedTableIds(child, path ? `${path}.${key}` : key));
  }
  return found;
}

describe('QuickBooks foreign keys', () => {
  /**
   * The plan generator resolves a foreign key with an exact `Map.get(linkedTableId)`
   * against the candidate tokens of each table's remote id — which for QuickBooks is
   * `[<rawEntityType>]`. A lower-cased `linkedTableId` produced no token match, so
   * every `ParentRef` was reported as "links to customer, which isn't in this plan"
   * and dropped from every export (DEV-11133).
   */
  it('names its link target with a token the plan generator can resolve', () => {
    const resolvableTokens = new Set(
      ENTITY_TYPES.flatMap((entityType) => linkedTableIdCandidateTokensForRemoteTableId([entityType])),
    );

    const unresolvable = ENTITY_TYPES.flatMap((entityType) =>
      collectLinkedTableIds(QBO_SCHEMA_MAP[entityType]).filter(
        (annotation) => !resolvableTokens.has(annotation.linkedTableId),
      ),
    );

    expect(unresolvable).toEqual([]);
  });

  it('agrees between linkedTableId and the linked table remote id', () => {
    for (const entityType of ENTITY_TYPES) {
      const schema = QBO_SCHEMA_MAP[entityType];
      const annotations = collectForeignKeyOptions(schema);
      for (const { linkedTableId, linkedTableRemoteId } of annotations) {
        expect(linkedTableRemoteId).toEqual([linkedTableId]);
      }
    }
  });

  /**
   * The default View used to collapse every named `*Ref` to its `.name` string via
   * `selectedSubfield`, and the subfield branch of `selectPlanFieldsFromTableView`
   * never reads a foreign key — so a heavily relational service exported nothing but
   * denormalized text (DEV-11132).
   */
  it.each([
    ['Invoice' as QuickBooksEntityType, 'CustomerRef', 'Customer'],
    ['Item' as QuickBooksEntityType, 'IncomeAccountRef', 'Account'],
    ['Bill' as QuickBooksEntityType, 'VendorRef', 'Vendor'],
    ['Customer' as QuickBooksEntityType, 'ParentRef', 'Customer'],
    ['Account' as QuickBooksEntityType, 'ParentRef', 'Account'],
    ['Vendor' as QuickBooksEntityType, 'TermRef', 'Term'],
  ])('keeps %s.%s a link to %s through plan field selection', (entityType, fieldName, linkedTableId) => {
    const spec = buildQuickBooksJsonTableSpec(entityId(entityType), entityType);
    const { schemaFields } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: buildQuickBooksDefaultView(spec.schema, entityType),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });

    const selected = schemaFields.find((field) => field.path === fieldName);
    expect(selected?.foreignKey?.linkedTableId).toBe(linkedTableId);
  });
});

describe('QuickBooks single-value wrappers', () => {
  function planFieldsFor(entityType: QuickBooksEntityType) {
    const spec = buildQuickBooksJsonTableSpec(entityId(entityType), entityType);
    return selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: buildQuickBooksDefaultView(spec.schema, entityType),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
  }

  /**
   * A wrapper left whole planned as raw JSON text at the destination
   * (`{"Address":"a@b.com"}`) — unusable for a mailto, a domain filter, or reading a
   * memo without stripping JSON (DEV-11135).
   */
  it.each([
    ['Customer' as QuickBooksEntityType, 'PrimaryEmailAddr.Address', 'email'],
    ['Customer' as QuickBooksEntityType, 'PrimaryPhone.FreeFormNumber', 'phone'],
    ['Customer' as QuickBooksEntityType, 'WebAddr.URI', 'url'],
    ['Vendor' as QuickBooksEntityType, 'PrimaryEmailAddr.Address', 'email'],
    ['Employee' as QuickBooksEntityType, 'PrimaryEmailAddr.Address', 'email'],
    ['Invoice' as QuickBooksEntityType, 'BillEmail.Address', 'email'],
    ['Invoice' as QuickBooksEntityType, 'CustomerMemo.value', 'string'],
  ])('plans %s as the inner %s, typed %s', (entityType, innerPath, expectedType) => {
    const { schemaFields, viewTypeByPath } = planFieldsFor(entityType);

    expect(schemaFields.map((field) => field.path)).toContain(innerPath);
    expect(viewTypeByPath[innerPath]).toBe(expectedType);
  });

  it('leaves genuinely composite objects whole', () => {
    const paths = planFieldsFor('Invoice').schemaFields.map((field) => field.path);

    expect(paths).toContain('BillAddr');
    expect(paths).toContain('Line');
    expect(paths.filter((path) => path.startsWith('BillAddr.'))).toEqual([]);
  });

  /**
   * These land on disk (the schemas are `additionalProperties: true`) but got no
   * column and so reached no destination — `Customer.Notes` is a first-class
   * 2000-char field in the QuickBooks UI (DEV-11134).
   */
  it.each([
    ['Customer' as QuickBooksEntityType, 'Notes'],
    ['Customer' as QuickBooksEntityType, 'Title'],
    ['Customer' as QuickBooksEntityType, 'Suffix'],
    ['Invoice' as QuickBooksEntityType, 'AllowOnlinePayPalPayment'],
    ['Invoice' as QuickBooksEntityType, 'AllowOnlineAffirmPayment'],
  ])('plans %s.%s, which the static schema used to omit', (entityType, fieldName) => {
    expect(planFieldsFor(entityType).schemaFields.map((field) => field.path)).toContain(fieldName);
  });
});

/** Every `x-scratch-foreign-key` options object in a schema, walked recursively. */
function collectForeignKeyOptions(
  schema: unknown,
): { linkedTableId: string; linkedTableRemoteId: string[] | undefined }[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const found: { linkedTableId: string; linkedTableRemoteId: string[] | undefined }[] = [];

  const foreignKey = node[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
    | { linkedTableId?: unknown; linkedTableRemoteId?: unknown }
    | undefined;
  if (typeof foreignKey?.linkedTableId === 'string') {
    found.push({
      linkedTableId: foreignKey.linkedTableId,
      linkedTableRemoteId: Array.isArray(foreignKey.linkedTableRemoteId)
        ? (foreignKey.linkedTableRemoteId as string[])
        : undefined,
    });
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === X_SCRATCH_FOREIGN_KEY_OPTIONS) continue;
    found.push(...collectForeignKeyOptions(child));
  }
  return found;
}
