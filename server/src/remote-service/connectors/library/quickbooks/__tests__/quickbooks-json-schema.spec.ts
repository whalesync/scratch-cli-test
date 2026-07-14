import { TableView, TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildQuickBooksDefaultView } from '../quickbooks-default-view';
import { buildQuickBooksJsonTableSpec } from '../quickbooks-json-schema';

function entityId(entityType: string): EntityId {
  return { wsId: entityType.toLowerCase(), remoteId: [entityType] };
}

function col(cols: TableView['cols'] | undefined, path: string): TableViewCol | undefined {
  return (cols ?? []).find((c): c is TableViewCol => c.kind === 'col' && c.path === path);
}

describe('buildQuickBooksJsonTableSpec — read-only annotations', () => {
  it('marks computed and system fields read-only in the default view', () => {
    const spec = buildQuickBooksJsonTableSpec(entityId('Invoice'), 'Invoice');
    const cols = buildQuickBooksDefaultView(spec.schema, 'Invoice').cols;

    // Computed (server-derived from the lines) and system (concurrency counter).
    expect(col(cols, 'TotalAmt')?.readonly).toBe(true);
    expect(col(cols, 'Balance')?.readonly).toBe(true);
    expect(col(cols, 'SyncToken')?.readonly).toBe(true);

    // A user-editable field stays editable.
    expect(col(cols, 'DocNumber')?.readonly).toBeFalsy();
  });

  it('marks the account CurrentBalance computed fields read-only', () => {
    const spec = buildQuickBooksJsonTableSpec(entityId('Account'), 'Account');
    const cols = buildQuickBooksDefaultView(spec.schema, 'Account').cols;
    expect(col(cols, 'CurrentBalance')?.readonly).toBe(true);
    expect(col(cols, 'CurrentBalanceWithSubAccounts')?.readonly).toBe(true);
    expect(col(cols, 'Name')?.readonly).toBeFalsy();
  });

  it('sets x-scratch-readonly on the schema property (for enforce_schema)', () => {
    const spec = buildQuickBooksJsonTableSpec(entityId('Invoice'), 'Invoice');
    const properties = (spec.schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    expect(properties.TotalAmt?.[X_SCRATCH_READONLY]).toBe(true);
    expect(properties.SyncToken?.[X_SCRATCH_READONLY]).toBe(true);
  });
});
