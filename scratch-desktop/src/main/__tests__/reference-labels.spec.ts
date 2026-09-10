import { describe, expect, it } from 'vitest';
import {
  buildIdToNameMap,
  collectReferencedIds,
  DEFAULT_REFERENCE_ID_PATH,
  extractFolderReferenceInfo,
  referenceIdToString,
  referenceNameToString,
  resolveLinkedFolder,
  resolveRemoteIdPath,
  workingRecordExistsInService,
  type FolderReferenceInfo,
} from '../reference-labels';

describe('extractFolderReferenceInfo', () => {
  it('reads wsId, remoteId segments, slug, id path, and title path from a schema wrapper', () => {
    const info = extractFolderReferenceInfo('/ws/Airtable/Stones', {
      id: { wsId: 'tblStones', remoteId: ['appABC', 'tblStones'] },
      slug: 'Stones',
      idColumnRemoteId: 'id',
      titleColumnRemoteId: ['fields', 'Name'],
      schema: {},
    });
    expect(info).toEqual({
      folderPath: '/ws/Airtable/Stones',
      wsId: 'tblStones',
      remoteIdSegments: ['appABC', 'tblStones'],
      slug: 'Stones',
      idPath: 'id',
      titlePath: ['fields', 'Name'],
    });
  });

  it('defaults the id path and nulls a missing title path', () => {
    const info = extractFolderReferenceInfo('/ws/X', { slug: 'X', schema: {} });
    expect(info?.idPath).toBe(DEFAULT_REFERENCE_ID_PATH);
    expect(info?.titlePath).toBeNull();
    expect(info?.wsId).toBeNull();
    expect(info?.remoteIdSegments).toEqual([]);
  });

  it('returns null when there is no schema wrapper', () => {
    expect(extractFolderReferenceInfo('/ws/X', null)).toBeNull();
  });
});

describe('resolveLinkedFolder', () => {
  const folder = (overrides: Partial<FolderReferenceInfo>): FolderReferenceInfo => ({
    folderPath: '/ws/folder',
    wsId: null,
    remoteIdSegments: [],
    slug: null,
    idPath: 'id',
    titlePath: ['name'],
    ...overrides,
  });

  it('matches on wsId first (HubSpot/Attio/Affinity idiom)', () => {
    const companies = folder({ folderPath: '/ws/Companies', wsId: 'companies' });
    const deals = folder({ folderPath: '/ws/Deals', wsId: 'deals' });
    expect(resolveLinkedFolder('companies', [deals, companies])).toBe(companies);
  });

  it('falls back to a remoteId segment (Airtable tbl… inside [app, tbl])', () => {
    const stones = folder({
      folderPath: '/ws/Stones',
      wsId: 'appABC',
      remoteIdSegments: ['appABC', 'tblStones'],
    });
    expect(resolveLinkedFolder('tblStones', [stones])).toBe(stones);
  });

  it('falls back to slug last (Supabase, where wsId is the project ref)', () => {
    const clients = folder({ folderPath: '/ws/Clients', wsId: 'projectref', slug: 'Clients' });
    expect(resolveLinkedFolder('Clients', [clients])).toBe(clients);
  });

  it('prefers a wsId match over a slug match in another folder', () => {
    const byWsId = folder({ folderPath: '/ws/A', wsId: 'target' });
    const bySlug = folder({ folderPath: '/ws/B', slug: 'target' });
    expect(resolveLinkedFolder('target', [bySlug, byWsId])).toBe(byWsId);
  });

  it('returns null when nothing matches or the id is empty', () => {
    expect(resolveLinkedFolder('missing', [folder({ wsId: 'other' })])).toBeNull();
    expect(resolveLinkedFolder('', [folder({ wsId: '' })])).toBeNull();
  });
});

describe('referenceIdToString', () => {
  it('keeps non-empty strings and stringifies finite numbers', () => {
    expect(referenceIdToString('rec_1')).toBe('rec_1');
    expect(referenceIdToString(168116437)).toBe('168116437');
    expect(referenceIdToString(0)).toBe('0');
  });

  it('rejects empty strings, non-finite numbers, and non-scalars', () => {
    expect(referenceIdToString('')).toBeNull();
    expect(referenceIdToString(Number.NaN)).toBeNull();
    expect(referenceIdToString(null)).toBeNull();
    expect(referenceIdToString({ id: 'x' })).toBeNull();
    expect(referenceIdToString(['a'])).toBeNull();
  });
});

describe('collectReferencedIds', () => {
  it('handles single string and numeric references', () => {
    expect(collectReferencedIds('rec_1')).toEqual(['rec_1']);
    expect(collectReferencedIds(42)).toEqual(['42']);
  });

  it('handles multi-references and drops non-id entries', () => {
    expect(collectReferencedIds(['a', 'b', '', null, { x: 1 }, 7])).toEqual(['a', 'b', '7']);
  });

  it('returns [] for empty / non-reference values', () => {
    expect(collectReferencedIds(null)).toEqual([]);
    expect(collectReferencedIds('')).toEqual([]);
    expect(collectReferencedIds({})).toEqual([]);
  });
});

describe('referenceNameToString', () => {
  it('accepts scalar names and rejects structured values', () => {
    expect(referenceNameToString('Acme Inc.')).toBe('Acme Inc.');
    expect(referenceNameToString(12)).toBe('12');
    expect(referenceNameToString(true)).toBe('true');
    expect(referenceNameToString('')).toBeNull();
    expect(referenceNameToString(['rich', 'text'])).toBeNull();
    expect(referenceNameToString({ plain_text: 'x' })).toBeNull();
  });
});

describe('buildIdToNameMap', () => {
  it('maps each record id to its name via the id and title paths', () => {
    const records = [
      { id: 'rec_1', fields: { Name: 'Diamond' } },
      { id: 'rec_2', fields: { Name: 'Ruby' } },
    ];
    const map = buildIdToNameMap(records, 'id', ['fields', 'Name']);
    expect(map.get('rec_1')).toBe('Diamond');
    expect(map.get('rec_2')).toBe('Ruby');
    expect(map.size).toBe(2);
  });

  it('supports nested id paths (e.g. Attio id.record_id) and numeric ids', () => {
    const records = [{ id: { record_id: 7 }, values: { name: 'Person' } }];
    const map = buildIdToNameMap(records, 'id.record_id', ['values', 'name']);
    expect(map.get('7')).toBe('Person');
  });

  it('skips records missing an id or a usable name', () => {
    const records = [{ id: 'rec_ok', name: 'Keep' }, { id: 'rec_noname', name: { rich: 'text' } }, { name: 'no id' }];
    const map = buildIdToNameMap(records, 'id', ['name']);
    expect(Array.from(map.entries())).toEqual([['rec_ok', 'Keep']]);
  });
});

describe('resolveRemoteIdPath (DEV-11059)', () => {
  it('prefers the DEV-10092 idPath, then the legacy idColumnRemoteId, then the default', () => {
    expect(resolveRemoteIdPath({ idPath: 'id.record_id', idColumnRemoteId: 'id' })).toBe('id.record_id');
    expect(resolveRemoteIdPath({ idColumnRemoteId: 'remote_id' })).toBe('remote_id');
    expect(resolveRemoteIdPath({})).toBe(DEFAULT_REFERENCE_ID_PATH);
    expect(resolveRemoteIdPath(null)).toBe(DEFAULT_REFERENCE_ID_PATH);
  });
});

describe('workingRecordExistsInService (DEV-11059)', () => {
  it('is true for a concrete, non-sentinel remote id (string or number)', () => {
    expect(workingRecordExistsInService({ id: 'rec_123' }, 'id')).toBe(true);
    expect(workingRecordExistsInService({ id: 42 }, 'id')).toBe(true);
  });

  it('reads a nested id path (e.g. Attio id.record_id)', () => {
    expect(workingRecordExistsInService({ id: { record_id: 'r_1' } }, 'id.record_id')).toBe(true);
  });

  it('is false for a not-yet-published create: no id, empty, or a Scratch pending sentinel', () => {
    expect(workingRecordExistsInService({ name: 'no id here' }, 'id')).toBe(false);
    expect(workingRecordExistsInService({ id: '' }, 'id')).toBe(false);
    expect(workingRecordExistsInService({ id: null }, 'id')).toBe(false);
    // Sync-created and revert-recreated records carry non-empty sentinel ids before publish.
    expect(workingRecordExistsInService({ id: 'scratch_pending_publish_abc123' }, 'id')).toBe(false);
    expect(workingRecordExistsInService({ id: 'scratch_pending_recreate_rec_old' }, 'id')).toBe(false);
  });

  it('is false when the id path resolves to an object or array (not a single id)', () => {
    expect(workingRecordExistsInService({ id: { a: 1 } }, 'id')).toBe(false);
    expect(workingRecordExistsInService({ id: ['a', 'b'] }, 'id')).toBe(false);
  });
});
