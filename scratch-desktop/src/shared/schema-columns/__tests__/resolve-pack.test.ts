import type { TableViewCol } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { packEditedCellValue } from '../resolve-pack';

/**
 * The editable foreign-key ARRAY column HubSpot emits for a record's associations
 * (see buildAssociationForeignKeyCol / buildAssociationCodec on the server): native
 * value `[{ id, type }, …]`, displayed as a comma-joined id list, packed back into
 * `[{ id }, …]` on edit.
 */
function hubspotAssociationColumn(): TableViewCol {
  return {
    kind: 'col',
    path: 'associations.companies.results',
    name: 'Associated Companies',
    foreignKey: { linkedTableId: 'companies' },
    displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
    codec: {
      toCore: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'array' } },
      fromCore: {
        type: 'map_array',
        options: { elementTransformer: { type: 'wrap_object', options: { template: { id: '$value' } } } },
      },
    },
  };
}

describe('packEditedCellValue', () => {
  it('packs a comma-joined id list into an array of { id } objects', () => {
    const result = packEditedCellValue(hubspotAssociationColumn(), '123, 456');
    expect(result).toEqual({ ok: true, value: [{ id: '123' }, { id: '456' }] });
  });

  it('tolerates missing spaces and stray whitespace around ids', () => {
    const result = packEditedCellValue(hubspotAssociationColumn(), '123,456 ,  789');
    expect(result).toEqual({ ok: true, value: [{ id: '123' }, { id: '456' }, { id: '789' }] });
  });

  it('packs a single id', () => {
    const result = packEditedCellValue(hubspotAssociationColumn(), '999');
    expect(result).toEqual({ ok: true, value: [{ id: '999' }] });
  });

  it('packs an empty cell into an empty array (clears every link)', () => {
    expect(packEditedCellValue(hubspotAssociationColumn(), '')).toEqual({ ok: true, value: [] });
    expect(packEditedCellValue(hubspotAssociationColumn(), '   ')).toEqual({ ok: true, value: [] });
  });

  it('drops empty segments from a trailing/duplicate comma', () => {
    const result = packEditedCellValue(hubspotAssociationColumn(), '123,,456,');
    expect(result).toEqual({ ok: true, value: [{ id: '123' }, { id: '456' }] });
  });

  it('preserves duplicate ids verbatim (HubSpot dedupes on publish, not here)', () => {
    const result = packEditedCellValue(hubspotAssociationColumn(), '123, 123');
    expect(result).toEqual({ ok: true, value: [{ id: '123' }, { id: '123' }] });
  });

  it('returns ok:false for a column with no codec (caller uses default coercion)', () => {
    const plainColumn: TableViewCol = { kind: 'col', path: 'properties.name', name: 'Name' };
    expect(packEditedCellValue(plainColumn, 'anything')).toEqual({ ok: false });
    expect(packEditedCellValue(undefined, 'anything')).toEqual({ ok: false });
  });

  it('splits on whitespace when the display join is join_space', () => {
    const col = hubspotAssociationColumn();
    col.displayTransformer = { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_space' } };
    expect(packEditedCellValue(col, 'a b   c')).toEqual({ ok: true, value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  });

  it('fails closed when fromCore is a server-only / unsupported arm', () => {
    const col = hubspotAssociationColumn();
    // A server-only FK arm must never pack on the client — it has no client runtime.
    col.codec = {
      fromCore: {
        type: 'source_fk_to_dest_fk',
        options: {},
      } as unknown as NonNullable<TableViewCol['codec']>['fromCore'],
    };
    expect(packEditedCellValue(col, '123')).toEqual({ ok: false });
  });
});
