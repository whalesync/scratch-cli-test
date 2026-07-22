import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { DbService } from '../../db/db.service';
import { ParsedContent, Schema } from '../../utils/objects';
import { FileReferenceService } from '../file-reference.service';
import { RefCleanerService } from '../ref-cleaner.service';
import { SchemaHelperService } from '../schema-helper.service';

/**
 * `extractReferences` is the pure schema-driven walk feeding the file_reference table
 * (delete-phase inbound-reference detection). No DB involved; the db/schema-helper deps
 * are only used by the persistence methods.
 */
function buildService(): FileReferenceService {
  return new FileReferenceService(
    {} as unknown as DbService,
    new RefCleanerService(),
    {} as unknown as SchemaHelperService,
  );
}

describe('FileReferenceService.extractReferences', () => {
  it('extracts a flat scalar FK literal (no map)', () => {
    const schema = Type.Object({
      id: Type.Number(),
      authorId: Type.Number({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'authors' } }),
    }) as unknown as Schema;
    const content: ParsedContent = { id: 1, authorId: 5 };

    const refs = buildService().extractReferences('/posts/a.json', content, schema);

    expect(refs).toEqual([{ sourceFilePath: '/posts/a.json', targetRemoteId: '5', targetRemoteTableId: 'authors' }]);
  });

  it('extracts linked-page ids from the Notion relation shape via the map-less id leaf (DEV-10942)', () => {
    // The relation envelope + leaf carry the SAME map-less FK options (see notion-json-schema).
    // The linked ids must come from the `relation[].id` leaf; the envelope path yields nothing
    // (its node is an object and there is no `map` to dig with) — in particular the property's
    // OWN `id` must NOT be emitted as a reference (the old `map: 'id'` envelope annotation did
    // exactly that, one bogus row per relation property).
    const fkOptions = { linkedTableId: 'categories-db' };
    const schema = Type.Object({
      id: Type.String(),
      properties: Type.Object({
        Category: Type.Object(
          {
            id: Type.String(),
            type: Type.String(),
            relation: Type.Array(Type.Object({ id: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions }) })),
            has_more: Type.Boolean(),
          },
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions },
        ),
      }),
    }) as unknown as Schema;
    const content: ParsedContent = {
      id: 'page_1',
      properties: {
        Category: {
          id: 'prop%3Aid',
          type: 'relation',
          relation: [{ id: 'linked-page-a' }, { id: 'linked-page-b' }],
          has_more: false,
        },
      },
    };

    const refs = buildService().extractReferences('/products/p.json', content, schema);

    expect(refs).toEqual([
      { sourceFilePath: '/products/p.json', targetRemoteId: 'linked-page-a', targetRemoteTableId: 'categories-db' },
      { sourceFilePath: '/products/p.json', targetRemoteId: 'linked-page-b', targetRemoteTableId: 'categories-db' },
    ]);
  });

  it('still honors `map` for an object-shaped FK node (the generic contract)', () => {
    const schema = Type.Object({
      id: Type.Number(),
      companyRef: Type.Object(
        { value: Type.String(), name: Type.String() },
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'companies', map: 'value' } },
      ),
    }) as unknown as Schema;
    const content: ParsedContent = { id: 1, companyRef: { value: 'com_9', name: 'Acme' } };

    const refs = buildService().extractReferences('/deals/d.json', content, schema);

    expect(refs).toEqual([
      { sourceFilePath: '/deals/d.json', targetRemoteId: 'com_9', targetRemoteTableId: 'companies' },
    ]);
  });
});
