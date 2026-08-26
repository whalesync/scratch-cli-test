import {
  associationDiffIsEmpty,
  bindCreatedRecordsByEchoedTraceId,
  chunkArchivePairsByUniqueFromId,
  chunkArray,
  describeBatchInputError,
  diffAssociationsById,
  failedPairsFromBatchAssociationResponse,
  groupAssociationWritesAcrossRecords,
  HubspotAssociationWriteError,
  HubspotBatchCreateUnmappableError,
  mapBatchCreateResponseToInputs,
  mapBatchUpdateResponseToInputs,
  matchCreatedRecordsToInputs,
  normalizePropertyValueForMatching,
} from '../hubspot-batch-publish';
import { HubspotRecord } from '../hubspot-types';

function record(id: string, properties: Record<string, string | null> = {}): HubspotRecord {
  return { id, properties: { hs_object_id: id, ...properties }, createdAt: '', updatedAt: '', archived: false };
}

const inputsOf = (...propertySets: Record<string, unknown>[]) => propertySets.map((properties) => ({ properties }));

describe('hubspot-batch-publish helpers (DEV-10200)', () => {
  describe('diffAssociationsById', () => {
    it('diffs by id only, per association type', () => {
      const diff = diffAssociationsById(
        {
          companies: {
            results: [
              { id: 'C1', type: 'x' },
              { id: 'C2', type: 'x' },
            ],
          },
        },
        {
          companies: {
            results: [
              { id: 'C2', type: 'y' },
              { id: 'C3', type: 'y' },
            ],
          },
          deals: { results: [{ id: 'D1', type: 'z' }] },
        },
      );
      expect([...diff.toCreateIdsByAssociationType]).toEqual([
        ['companies', ['C3']],
        ['deals', ['D1']],
      ]);
      expect([...diff.toDeleteIdsByAssociationType]).toEqual([['companies', ['C1']]]);
      expect(associationDiffIsEmpty(diff)).toBe(false);
    });

    it('is empty when desired matches current by id, whatever the labels/types say', () => {
      const diff = diffAssociationsById(
        { companies: { results: [{ id: 'C1', type: 'contact_to_company' }] } },
        { companies: { results: [{ id: 'C1', type: '' }] } },
      );
      expect(associationDiffIsEmpty(diff)).toBe(true);
    });

    it('treats a missing type on one side as an empty set (desired {} clears everything)', () => {
      const diff = diffAssociationsById({ companies: { results: [{ id: 'C1', type: 'x' }] } }, {});
      expect([...diff.toDeleteIdsByAssociationType]).toEqual([['companies', ['C1']]]);
      expect(diff.toCreateIdsByAssociationType.size).toBe(0);
    });
  });

  describe('groupAssociationWritesAcrossRecords', () => {
    it('merges every record’s pairs into one list per (type, op), in input order', () => {
      const grouped = groupAssociationWritesAcrossRecords([
        {
          recordId: 'R1',
          diff: diffAssociationsById(
            { companies: { results: [{ id: 'C9', type: '' }] } },
            { companies: { results: [{ id: 'C1', type: '' }] }, deals: { results: [{ id: 'D1', type: '' }] } },
          ),
        },
        {
          recordId: 'R2',
          diff: diffAssociationsById(
            {},
            {
              companies: {
                results: [
                  { id: 'C1', type: '' },
                  { id: 'C2', type: '' },
                ],
              },
            },
          ),
        },
      ]);
      expect([...grouped.pairsToCreateByAssociationType]).toEqual([
        [
          'companies',
          [
            { fromId: 'R1', toId: 'C1' },
            { fromId: 'R2', toId: 'C1' },
            { fromId: 'R2', toId: 'C2' },
          ],
        ],
        ['deals', [{ fromId: 'R1', toId: 'D1' }]],
      ]);
      expect([...grouped.pairsToArchiveByAssociationType]).toEqual([['companies', [{ fromId: 'R1', toId: 'C9' }]]]);
    });
  });

  describe('chunking', () => {
    it('chunkArray splits into consecutive chunks with a shorter tail', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
      expect(chunkArray([], 3)).toEqual([]);
      expect(() => chunkArray([1], 0)).toThrow();
    });

    it('chunkArchivePairsByUniqueFromId keeps all pairs of one from id together and caps unique from ids', () => {
      const chunks = chunkArchivePairsByUniqueFromId(
        [
          { fromId: 'A', toId: '1' },
          { fromId: 'B', toId: '1' },
          { fromId: 'A', toId: '2' },
          { fromId: 'C', toId: '1' },
        ],
        2,
      );
      expect(chunks).toEqual([
        [
          { fromId: 'A', toId: '1' },
          { fromId: 'A', toId: '2' },
          { fromId: 'B', toId: '1' },
        ],
        [{ fromId: 'C', toId: '1' }],
      ]);
    });
  });

  describe('matchCreatedRecordsToInputs / normalizePropertyValueForMatching', () => {
    it('normalizes the way HubSpot re-renders values (case, numbers, timestamps, empties)', () => {
      expect(normalizePropertyValueForMatching(' A@Example.com ')).toBe('a@example.com');
      expect(normalizePropertyValueForMatching('12.50')).toBe(normalizePropertyValueForMatching(12.5));
      expect(normalizePropertyValueForMatching('2024-01-01T10:00:00Z')).toBe(
        normalizePropertyValueForMatching('2024-01-01T10:00:00.000Z'),
      );
      expect(normalizePropertyValueForMatching(true)).toBe('true');
      expect(normalizePropertyValueForMatching('')).toBeUndefined();
      expect(normalizePropertyValueForMatching(null)).toBeUndefined();
    });

    it('binds each input to the record echoing its values, whatever order HubSpot returns them in', () => {
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { email: 'A@example.com' }],
          [2, { email: 'c@example.com' }],
        ]),
        [record('9', { email: 'c@example.com' }), record('8', { email: 'a@example.com' })],
      );
      expect([...(matched ?? []).entries()].map(([index, r]) => [index, r.id])).toEqual([
        [0, '8'],
        [2, '9'],
      ]);
    });

    it('accepts indistinguishable inputs (identical sent values) with any assignment', () => {
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { firstname: 'Same' }],
          [1, { firstname: 'Same' }],
        ]),
        [record('1', { firstname: 'Same' }), record('2', { firstname: 'Same' })],
      );
      expect(matched?.size).toBe(2);
      expect(new Set([...(matched ?? []).values()].map((r) => r.id))).toEqual(new Set(['1', '2']));
    });

    it('a property that other records echo counts as a mismatch when a record lacks it (no lenient swap)', () => {
      // Input 1 sent a phone; record 2 echoes it, record 1 does not. Input 0 (no phone) is
      // compatible with both, input 1 only with record 2 — a unique, correct binding.
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { firstname: 'Same' }],
          [1, { firstname: 'Same', phone: '+1 555' }],
        ]),
        [record('1', { firstname: 'Same' }), record('2', { firstname: 'Same', phone: '+1 555' })],
      );
      expect([...(matched ?? []).entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '1'],
        [1, '2'],
      ]);
    });

    it('ignores a property that no record echoes (it cannot tell inputs apart) but binds on the rest', () => {
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { email: 'a@x.com', secret: 'dropped-by-hubspot' }],
          [1, { email: 'b@x.com', secret: 'dropped-by-hubspot' }],
        ]),
        [record('2', { email: 'b@x.com' }), record('1', { email: 'a@x.com' })],
      );
      expect([...(matched ?? []).entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '1'],
        [1, '2'],
      ]);
    });

    it('binds exactly first: "001" and "1" (or "Acme" and "acme") never trade records even though they normalize alike', () => {
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { code: '001', name: 'Acme' }],
          [1, { code: '1', name: 'acme' }],
        ]),
        [record('9', { code: '1', name: 'acme' }), record('8', { code: '001', name: 'Acme' })],
      );
      expect([...(matched ?? []).entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '8'],
        [1, '9'],
      ]);
    });

    it('falls back to normalized comparison only when exact binding is impossible (HubSpot lower-cased the email)', () => {
      const matched = matchCreatedRecordsToInputs(
        new Map([
          [0, { email: 'A@X.com' }],
          [1, { email: 'B@X.com' }],
        ]),
        [record('2', { email: 'b@x.com' }), record('1', { email: 'a@x.com' })],
      );
      expect([...(matched ?? []).entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '1'],
        [1, '2'],
      ]);
    });

    it('refuses when only the normalized pass matches and the inputs differ exactly (HubSpot collapsed "001" and "1")', () => {
      expect(
        matchCreatedRecordsToInputs(
          new Map([
            [0, { code: '001' }],
            [1, { code: '1' }],
          ]),
          [record('1', { code: '1' }), record('2', { code: '1' })],
        ),
      ).toBeUndefined();
    });

    it('refuses a three-way alternating cycle (two valid matchings, no direct swap)', () => {
      expect(
        matchCreatedRecordsToInputs(
          new Map([
            [0, { a: 'x' }],
            [1, { b: 'y' }],
            [2, { c: 'z' }],
          ]),
          [record('R0', { a: 'x', c: 'z' }), record('R1', { a: 'x', b: 'y' }), record('R2', { b: 'y', c: 'z' })],
        ),
      ).toBeUndefined();
    });

    it('treats inputs differing only in a property NO record echoes as different (refuses, never guesses)', () => {
      expect(
        matchCreatedRecordsToInputs(
          new Map([
            [0, { firstname: 'Same', secret: 'A' }],
            [1, { firstname: 'Same', secret: 'B' }],
          ]),
          [record('1', { firstname: 'Same' }), record('2', { firstname: 'Same' })],
        ),
      ).toBeUndefined();
    });

    it('needs no fingerprint for a single input ↔ single record', () => {
      const matched = matchCreatedRecordsToInputs(new Map([[0, { x: 'sent' }]]), [record('1', { x: 'rewritten' })]);
      expect(matched?.get(0)?.id).toBe('1');
    });

    it('returns undefined when a record matches no input (unexpected normalization) or counts differ', () => {
      expect(
        matchCreatedRecordsToInputs(
          new Map([
            [0, { email: 'a@example.com' }],
            [1, { email: 'b@example.com' }],
          ]),
          [record('1', { email: 'a@example.com' }), record('2', { email: 'zzz@example.com' })],
        ),
      ).toBeUndefined();
      expect(matchCreatedRecordsToInputs(new Map([[0, {}]]), [record('1'), record('2')])).toBeUndefined();
    });
  });

  describe('bindCreatedRecordsByEchoedTraceId', () => {
    const traced = (...traceIds: string[]) => traceIds.map((objectWriteTraceId) => ({ objectWriteTraceId }));
    const echoing = (id: string, objectWriteTraceId?: string) => ({ ...record(id), objectWriteTraceId });

    it('binds every result to the input whose trace id it echoes, whatever the order and properties, in input order', () => {
      const bound = bindCreatedRecordsByEchoedTraceId(traced('0', '1', '2'), new Set([0, 1, 2]), [
        echoing('12', '2'),
        echoing('10', '0'),
        echoing('11', '1'),
      ]);
      expect([...(bound ?? new Map<number, HubspotRecord>()).entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [1, '11'],
        [2, '12'],
      ]);
    });

    it('skips rejected inputs: a 207 body echoes traces only for the created records', () => {
      const bound = bindCreatedRecordsByEchoedTraceId(traced('0', '1', '2'), new Set([0, 2]), [
        echoing('12', '2'),
        echoing('10', '0'),
      ]);
      expect([...(bound ?? new Map<number, HubspotRecord>()).keys()].sort()).toEqual([0, 2]);
    });

    it.each([
      ['a result without a trace id', [echoing('10', '0'), echoing('11')]],
      ['a trace id no input sent', [echoing('10', '0'), echoing('11', '9')]],
      ['two results echoing the same trace id', [echoing('10', '0'), echoing('11', '0')]],
      ['a trace id of a rejected input', [echoing('10', '0'), echoing('11', '2')]],
      ['fewer results than unrejected inputs', [echoing('10', '0')]],
    ])('returns undefined (so property matching takes over) for %s', (_label, records) => {
      expect(bindCreatedRecordsByEchoedTraceId(traced('0', '1', '2'), new Set([0, 1]), records)).toBeUndefined();
    });

    it('returns undefined when the request itself carried no or duplicate trace ids', () => {
      expect(
        bindCreatedRecordsByEchoedTraceId([{}, {}], new Set([0, 1]), [echoing('10', '0'), echoing('11', '1')]),
      ).toBeUndefined();
      expect(
        bindCreatedRecordsByEchoedTraceId(traced('0', '0'), new Set([0, 1]), [echoing('10', '0'), echoing('11', '0')]),
      ).toBeUndefined();
    });
  });

  describe('mapBatchCreateResponseToInputs', () => {
    it('binds by the echoed trace id first: records whose properties could not tell the inputs apart still land on the right file', () => {
      const inputs = [
        { objectWriteTraceId: '0', properties: { firstname: 'Twin' } },
        { objectWriteTraceId: '1', properties: { firstname: 'Twin' } },
      ];
      const outcome = mapBatchCreateResponseToInputs(
        {
          status: 'COMPLETE',
          results: [
            { ...record('11', { firstname: 'Twin' }), objectWriteTraceId: '1' },
            { ...record('10', { firstname: 'Twin' }), objectWriteTraceId: '0' },
          ],
        },
        inputs,
      );
      expect([...outcome.recordsByInputIndex.entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [1, '11'],
      ]);
    });

    it('binds a 207 body by echoed trace ids: the rejected input is skipped, the created ones bind regardless of order', () => {
      const inputs = ['a@x.com', 'not-an-email', 'c@x.com'].map((email, index) => ({
        objectWriteTraceId: String(index),
        properties: { email },
      }));
      const outcome = mapBatchCreateResponseToInputs(
        {
          status: 'COMPLETE',
          results: [
            { ...record('12', { email: 'c@x.com' }), objectWriteTraceId: '2' },
            { ...record('10', { email: 'a@x.com' }), objectWriteTraceId: '0' },
          ],
          numErrors: 1,
          errors: [
            { status: 'error', category: 'VALIDATION_ERROR', message: 'x', context: { objectWriteTraceId: ['1'] } },
          ],
        },
        inputs,
      );
      expect([...outcome.recordsByInputIndex.entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [2, '12'],
      ]);
      expect([...outcome.failureMessagesByInputIndex.keys()]).toEqual([1]);
    });

    it('falls back to echoed-property matching when the results carry no trace id (results arrive reversed)', () => {
      const outcome = mapBatchCreateResponseToInputs(
        { status: 'COMPLETE', results: [record('11', { email: 'b@x.com' }), record('10', { email: 'a@x.com' })] },
        [
          { objectWriteTraceId: '0', properties: { email: 'a@x.com' } },
          { objectWriteTraceId: '1', properties: { email: 'b@x.com' } },
        ],
      );
      expect([...outcome.recordsByInputIndex.entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [1, '11'],
      ]);
    });

    it('maps a fully successful 201 body onto inputs by echoed properties (results arrive reversed)', () => {
      const outcome = mapBatchCreateResponseToInputs(
        { status: 'COMPLETE', results: [record('11', { email: 'b@x.com' }), record('10', { email: 'a@x.com' })] },
        inputsOf({ email: 'a@x.com' }, { email: 'b@x.com' }),
      );
      expect([...outcome.recordsByInputIndex.entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [1, '11'],
      ]);
      expect(outcome.failureMessagesByInputIndex.size).toBe(0);
    });

    it('maps a 207 body: the failed trace id is skipped and the remaining records bind by properties', () => {
      const outcome = mapBatchCreateResponseToInputs(
        {
          status: 'COMPLETE',
          results: [record('12', { email: 'c@x.com' }), record('10', { email: 'a@x.com' })],
          numErrors: 1,
          errors: [
            {
              status: 'error',
              category: 'VALIDATION_ERROR',
              message: 'Property values were not valid',
              context: { objectWriteTraceId: ['1'] },
            },
          ],
        },
        inputsOf({ email: 'a@x.com' }, { email: 'not-an-email' }, { email: 'c@x.com' }),
      );
      expect([...outcome.recordsByInputIndex.entries()].map(([i, r]) => [i, r.id])).toEqual([
        [0, '10'],
        [2, '12'],
      ]);
      expect(outcome.failureMessagesByInputIndex.get(1)).toBe(
        'VALIDATION_ERROR: Property values were not valid (objectWriteTraceId=1)',
      );
    });

    it('throws an unmappable error naming the created ids when counts differ', () => {
      let thrown: unknown;
      try {
        mapBatchCreateResponseToInputs(
          {
            status: 'COMPLETE',
            results: [record('10')],
            errors: [{ status: 'error', category: 'INTERNAL_ERROR', message: 'boom' }],
          },
          inputsOf({ a: '1' }, { a: '2' }, { a: '3' }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HubspotBatchCreateUnmappableError);
      expect((thrown as HubspotBatchCreateUnmappableError).createdRecordIds).toEqual(['10']);
      expect((thrown as Error).message).toMatch(/Created HubSpot ids: \[10\]/);
    });

    it('throws an unmappable error when the echoed properties contradict every binding', () => {
      expect(() =>
        mapBatchCreateResponseToInputs(
          { status: 'COMPLETE', results: [record('1', { email: 'a@x.com' }), record('2', { email: 'q@x.com' })] },
          inputsOf({ email: 'a@x.com' }, { email: 'b@x.com' }),
        ),
      ).toThrow(HubspotBatchCreateUnmappableError);
    });
  });

  describe('batch status handling', () => {
    it('create: a non-terminal status is unmappable — the listed records are rolled back, the inputs retried one per call', () => {
      let thrown: unknown;
      try {
        mapBatchCreateResponseToInputs({ status: 'PENDING', results: [record('7')] }, inputsOf({ a: '1' }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HubspotBatchCreateUnmappableError);
      expect((thrown as HubspotBatchCreateUnmappableError).createdRecordIds).toEqual(['7']);
    });

    it('create: numErrors larger than the listed errors is unmappable (names the created ids)', () => {
      expect(() =>
        mapBatchCreateResponseToInputs(
          { status: 'COMPLETE', results: [record('1', { a: '1' })], numErrors: 1 },
          inputsOf({ a: '1' }),
        ),
      ).toThrow(HubspotBatchCreateUnmappableError);
    });

    it('update: a non-terminal status fails every input (the retry re-applies the idempotent update)', () => {
      const outcome = mapBatchUpdateResponseToInputs({ status: 'PROCESSING', results: [] }, [{ id: '1' }, { id: '2' }]);
      expect(outcome.recordsByInputIndex.size).toBe(0);
      expect([...outcome.failureMessagesByInputIndex.keys()]).toEqual([0, 1]);
      expect(outcome.failureMessagesByInputIndex.get(0)).toMatch(/did not complete/);
    });
  });

  describe('mapBatchUpdateResponseToInputs', () => {
    it('matches successes by id regardless of result order and attributes failures by trace id, then by ids context', () => {
      const outcome = mapBatchUpdateResponseToInputs(
        {
          status: 'COMPLETE',
          results: [record('3'), record('1')],
          errors: [
            { status: 'error', category: 'VALIDATION_ERROR', message: 'bad', context: { objectWriteTraceId: ['1'] } },
            { status: 'error', category: 'OBJECT_NOT_FOUND', message: 'missing', context: { ids: ['4'] } },
          ],
        },
        [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
      );
      expect([...outcome.recordsByInputIndex.keys()]).toEqual([0, 2]);
      expect(outcome.failureMessagesByInputIndex.get(1)).toMatch(/^VALIDATION_ERROR: bad/);
      expect(outcome.failureMessagesByInputIndex.get(3)).toMatch(/^OBJECT_NOT_FOUND: missing/);
    });
  });

  describe('failedPairsFromBatchAssociationResponse', () => {
    const sent = [
      { fromId: 'R1', toId: 'C1' },
      { fromId: 'R2', toId: 'C2' },
    ];

    it('attributes an error to the pairs whose from/to id it names', () => {
      const failed = failedPairsFromBatchAssociationResponse(
        {
          status: 'COMPLETE',
          results: [],
          errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'nope', context: { toObjectId: ['C2'] } }],
        },
        sent,
        'contacts',
        'companies',
      );
      expect(failed).toEqual([
        {
          fromId: 'R2',
          toId: 'C2',
          fromObjectType: 'contacts',
          toObjectType: 'companies',
          reason: 'OBJECT_NOT_FOUND: nope (toObjectId=C2)',
        },
      ]);
    });

    it('with both a from and a to id in the context, blames only the exact pair (not every pair sharing the company)', () => {
      const failed = failedPairsFromBatchAssociationResponse(
        {
          status: 'COMPLETE',
          results: [],
          errors: [
            {
              status: 'error',
              category: 'OBJECT_NOT_FOUND',
              message: 'nope',
              context: { fromObjectId: ['R1'], toObjectId: ['C'] },
            },
          ],
        },
        [
          { fromId: 'R1', toId: 'C' },
          { fromId: 'R2', toId: 'C' },
        ],
        'contacts',
        'companies',
      );
      expect(failed.map((pair) => pair.fromId)).toEqual(['R1']);
    });

    it('fails every pair when the response is not COMPLETE or reports unlisted errors', () => {
      expect(
        failedPairsFromBatchAssociationResponse({ status: 'PENDING', results: [] }, sent, 'contacts', 'companies').map(
          (pair) => pair.fromId,
        ),
      ).toEqual(['R1', 'R2']);
      expect(
        failedPairsFromBatchAssociationResponse(
          { status: 'COMPLETE', results: [], numErrors: 1 },
          sent,
          'contacts',
          'companies',
        ).map((pair) => pair.fromId),
      ).toEqual(['R1', 'R2']);
    });

    it('attributes an error naming no sent id to every pair (conservative)', () => {
      const failed = failedPairsFromBatchAssociationResponse(
        { status: 'COMPLETE', results: [], errors: [{ status: 'error', category: 'INTERNAL_ERROR', message: 'x' }] },
        sent,
        'contacts',
        'companies',
      );
      expect(failed.map((pair) => pair.fromId)).toEqual(['R1', 'R2']);
    });

    it('returns nothing for a clean response', () => {
      expect(
        failedPairsFromBatchAssociationResponse({ status: 'COMPLETE', results: [{}] }, sent, 'contacts', 'companies'),
      ).toEqual([]);
    });
  });

  it('HubspotAssociationWriteError names every failed pair', () => {
    const error = new HubspotAssociationWriteError([
      { fromId: 'R1', toId: 'C1', fromObjectType: 'contacts', toObjectType: 'companies', reason: 'nope' },
    ]);
    expect(error.message).toBe('HubSpot rejected 1 association write(s): contacts/R1 → companies/C1 (nope)');
    expect(error.category).toBe('ASSOCIATION_WRITE_FAILED');
  });

  it('describeBatchInputError tolerates a bare error', () => {
    expect(describeBatchInputError({ status: 'error' })).toBe('no reason given');
  });
});
