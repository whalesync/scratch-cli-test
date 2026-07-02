import { TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildCopperJsonTableSpec } from '../copper-json-schema';
import { CopperCustomFieldDefinition, CopperEntityType } from '../copper-types';

function viewFor(entityType: CopperEntityType, defs: CopperCustomFieldDefinition[] = []) {
  const id: EntityId = { wsId: entityType, remoteId: [entityType] };
  const spec = buildCopperJsonTableSpec(id, entityType, defs);
  if (!spec.defaultView) throw new Error('expected a default view');
  return spec.defaultView;
}

function flatCol(view: { cols: (TableViewCol | TableViewBannerGroup)[] }, path: string): TableViewCol | undefined {
  return view.cols.find((c): c is TableViewCol => c.kind === 'col' && c.path === path);
}

function bannerGroup(
  view: { cols: (TableViewCol | TableViewBannerGroup)[] },
  name: string,
): TableViewBannerGroup | undefined {
  return view.cols.find((c): c is TableViewBannerGroup => c.kind === 'banner-group' && c.name === name);
}

describe('buildCopperDefaultView', () => {
  it('renders system fields flat with id first and read-only flags propagated', () => {
    const view = viewFor('people');
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', readonly: true });
    expect(flatCol(view, 'name')?.readonly).toBe(false);
    // Title-cased system field labels.
    expect(flatCol(view, 'first_name')?.name).toBe('First Name');
    // Computed/system fields are read-only.
    expect(flatCol(view, 'date_modified')?.readonly).toBe(true);
    // company_id is read-only on People (set via Related Items).
    expect(flatCol(view, 'company_id')?.readonly).toBe(true);
  });

  it('omits the Custom Fields banner when the account has no custom fields', () => {
    const view = viewFor('companies');
    expect(bannerGroup(view, 'Custom Fields')).toBeUndefined();
  });

  it('groups custom fields under a "Custom Fields" banner, addressed by definition id', () => {
    const defs: CopperCustomFieldDefinition[] = [
      { id: 9001, name: 'Industry', data_type: 'Dropdown' },
      { id: 9002, name: 'Score', data_type: 'Float' },
      { id: 9003, name: 'Linked Deal', data_type: 'Connect' },
    ];
    const view = viewFor('companies', defs);

    // Custom fields are NOT flat columns.
    expect(flatCol(view, 'custom_fields.[custom_field_definition_id=9001].value')).toBeUndefined();

    const group = bannerGroup(view, 'Custom Fields');
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.cols.map((c) => c.path)).toEqual([
      'custom_fields.[custom_field_definition_id=9001].value',
      'custom_fields.[custom_field_definition_id=9002].value',
      'custom_fields.[custom_field_definition_id=9003].value',
    ]);
    // Column name comes from the definition; type from data_type.
    expect(group.cols[0]).toMatchObject({ name: 'Industry', type: 'string' });
    expect(group.cols[1]).toMatchObject({ name: 'Score', type: 'number' });
    // Connect is read-only (derived from the definition).
    expect(group.cols.find((c) => c.path.endsWith('=9003].value'))?.readonly).toBe(true);
    expect(group.cols.find((c) => c.path.endsWith('=9002].value'))?.readonly).toBeUndefined();
  });
});
