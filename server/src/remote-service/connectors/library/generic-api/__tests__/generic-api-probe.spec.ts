/**
 * Tests for the probe orchestrator (PR 5).
 *
 * Covers:
 *   - probeAuthOnly: one HTTP call, throws on no-endpoints / non-2xx
 *   - probeEndpointForTable: page 1 + page 2 verification + schema inference
 *   - diffProbeResults: signals each kind of drift correctly
 */

import { GenericApiConnectorExtras, GenericApiFolderOptions } from '@spinner/shared-types';
import { FetchFn } from '../apiget';
import { diffProbeResults, probeAuthOnly, probeEndpointForTable } from '../generic-api-probe';

const baseExtras: GenericApiConnectorExtras = {
  apiType: 'rest',
  authHeader: { style: 'bearer' },
  endpoints: [{ id: 'ep_1', method: 'GET', url: 'https://api.example.com/v1/projects' }],
};

// ─────────────────────────────────────────────────────────────────────────────
// probeAuthOnly
// ─────────────────────────────────────────────────────────────────────────────

describe('probeAuthOnly', () => {
  it('throws on empty endpoints list', async () => {
    await expect(probeAuthOnly({ extras: { ...baseExtras, endpoints: [] }, apiKey: 'k' })).rejects.toThrow(
      /No endpoints/,
    );
  });

  it('resolves on 2xx + JSON response', async () => {
    const fetch: FetchFn = () =>
      Promise.resolve({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' });
    await expect(probeAuthOnly({ extras: baseExtras, apiKey: 'k', fetch })).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeEndpointForTable
// ─────────────────────────────────────────────────────────────────────────────

describe('probeEndpointForTable', () => {
  it('walks page 1 only when no pagination is detectable, infers schema', async () => {
    const fetch: FetchFn = () =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { id: 'r1', name: 'Alpha' },
          { id: 'r2', name: 'Beta' },
        ]),
      });
    const result = await probeEndpointForTable({ extras: baseExtras, apiKey: 'k', endpointId: 'ep_1', fetch });
    expect(result.page1Status).toBe('ok');
    expect(result.page2Status).toBe('no-pagination');
    expect(result.recordsWalked).toBe(2);
    expect(result.probe.detectedPagination).toBeNull();
    expect(result.probe.extractionIdPath).toBe('id');
    // Schema should reflect the two fields
    const schema = result.probe.inferredSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['id', 'name']));
  });

  it('walks page 1 + page 2 when pagination is detected', async () => {
    let call = 0;
    const fetch: FetchFn = () => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            results: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
            next_cursor: 'cur1',
          }),
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results: [{ id: 'r4' }, { id: 'r5' }] }),
      });
    };
    const result = await probeEndpointForTable({ extras: baseExtras, apiKey: 'k', endpointId: 'ep_1', fetch });
    expect(result.page2Status).toBe('ok');
    expect(result.page2RecordCount).toBe(2);
    expect(result.recordsWalked).toBe(5);
    expect(result.probe.detectedPagination?.type).toBe('cursor');
  });

  it('throws when the endpoint does not exist on the connection', async () => {
    await expect(
      probeEndpointForTable({ extras: baseExtras, apiKey: 'k', endpointId: 'ep_does_not_exist' }),
    ).rejects.toThrow(/not found/);
  });

  it('respects an extractionIdPath override', async () => {
    const fetch: FetchFn = () =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ uuid: 'u1' }]),
      });
    const result = await probeEndpointForTable({
      extras: baseExtras,
      apiKey: 'k',
      endpointId: 'ep_1',
      extractionIdPath: 'uuid',
      fetch,
    });
    expect(result.probe.extractionIdPath).toBe('uuid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diffProbeResults
// ─────────────────────────────────────────────────────────────────────────────

function probe(overrides: Partial<GenericApiFolderOptions['probe']> = {}): GenericApiFolderOptions['probe'] {
  return {
    detectedPagination: null,
    extractionIdPath: 'id',
    inferredSchema: { type: 'object', properties: { id: { type: 'string' } } },
    lastProbedAt: '2026-05-18T20:00:00Z',
    ...overrides,
  };
}

describe('diffProbeResults', () => {
  it('reports no drift when probes are identical', () => {
    const d = diffProbeResults(probe(), probe());
    expect(d.extractionIdPathChanged).toBe(false);
    expect(d.paginationStrategyChanged).toBe(false);
    expect(d.schemaFieldsAdded).toEqual([]);
    expect(d.schemaFieldsRemoved).toEqual([]);
  });

  it('flags extractionIdPath drift (the hard-stop case)', () => {
    const d = diffProbeResults(probe(), probe({ extractionIdPath: 'uuid' }));
    expect(d.extractionIdPathChanged).toBe(true);
  });

  it('flags pagination Strategy change', () => {
    const d = diffProbeResults(
      probe(),
      probe({
        detectedPagination: { type: 'cursor', cursorPath: 'next_cursor', cursorParam: 'cursor', dataPath: 'results' },
      }),
    );
    expect(d.paginationStrategyChanged).toBe(true);
  });

  it('lists added schema fields', () => {
    const next = probe({
      inferredSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, created_at: { type: 'string' } },
      },
    });
    const d = diffProbeResults(probe(), next);
    expect(d.schemaFieldsAdded.sort()).toEqual(['created_at', 'name']);
    expect(d.schemaFieldsRemoved).toEqual([]);
  });

  it('lists removed schema fields', () => {
    const previous = probe({
      inferredSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, deprecated_field: { type: 'string' } },
      },
    });
    const d = diffProbeResults(previous, probe());
    expect(d.schemaFieldsRemoved).toEqual(['deprecated_field']);
    expect(d.schemaFieldsAdded).toEqual([]);
  });
});
