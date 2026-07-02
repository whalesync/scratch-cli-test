import { describe, expect, it } from 'vitest';
import { compareFlattenedRecordVersions, deriveKeyedArrayPathsFromColumnIds, flattenObject } from '../local-files';

/**
 * Verbatim keyed arrays (`x-scratch-array-keyed-by`, DEV-10637): the diff must be
 * per element so each custom-field column gets its own unreviewed/unpublished
 * dot, while every OTHER array stays an atomic leaf exactly as before.
 */

const CF = 'custom_fields';
const TIER = 'custom_fields.[custom_field_definition_id=755332].value';
const SCORE = 'custom_fields.[custom_field_definition_id=755333].value';

describe('deriveKeyedArrayPathsFromColumnIds', () => {
  it('recovers keyField + valuePath from filter-segment column ids', () => {
    const map = deriveKeyedArrayPathsFromColumnIds(['id', 'name', TIER, SCORE]);
    expect(map.get(CF)).toEqual({ keyField: 'custom_field_definition_id', valuePath: 'value' });
    expect(map.size).toBe(1);
  });

  it('ignores plain (non-filter) column ids', () => {
    const map = deriveKeyedArrayPathsFromColumnIds(['id', 'name', 'metadata.author']);
    expect(map.size).toBe(0);
  });

  it('handles a filter segment with no value sub-path (whole element)', () => {
    const map = deriveKeyedArrayPathsFromColumnIds(['fields.[id=abc]']);
    expect(map.get('fields')).toEqual({ keyField: 'id', valuePath: undefined });
  });
});

describe('flattenObject', () => {
  it('keeps an ordinary (non-keyed) array as an atomic leaf', () => {
    const flat = flattenObject({ id: 1, tags: ['a', 'b'] });
    expect(flat).toEqual({ id: 1, tags: ['a', 'b'] });
  });

  it('still flattens nested objects to dot-paths', () => {
    const flat = flattenObject({ id: 1, metadata: { author: 'jane' } });
    expect(flat).toEqual({ id: 1, 'metadata.author': 'jane' });
  });

  it('expands a keyed array into one leaf per element addressed by its key field', () => {
    const keyed = deriveKeyedArrayPathsFromColumnIds([TIER, SCORE]);
    const flat = flattenObject(
      {
        id: 401,
        custom_fields: [
          { custom_field_definition_id: 755332, value: 'Enterprise' },
          { custom_field_definition_id: 755333, value: 9.5 },
        ],
      },
      '',
      undefined,
      keyed,
    );
    expect(flat).toEqual({ id: 401, [TIER]: 'Enterprise', [SCORE]: 9.5 });
    // The whole-array key is NOT emitted — the per-element keys carry every change.
    expect(flat[CF]).toBeUndefined();
  });

  it('does not expand the same array when no keyed-array metadata is supplied', () => {
    const flat = flattenObject({
      custom_fields: [{ custom_field_definition_id: 755332, value: 'Enterprise' }],
    });
    expect(Array.isArray(flat[CF])).toBe(true);
  });
});

describe('compareFlattenedRecordVersions — per-element keyed-array dots', () => {
  const keyed = deriveKeyedArrayPathsFromColumnIds([TIER, SCORE]);
  const flatten = (record: Record<string, unknown>) => flattenObject(record, '', undefined, keyed);

  const original = {
    id: 401,
    custom_fields: [
      { custom_field_definition_id: 755332, value: 'Enterprise' },
      { custom_field_definition_id: 755333, value: 9.5 },
    ],
  };

  it('flags only the edited element as unreviewed, keyed by its filter path', () => {
    const working = {
      id: 401,
      custom_fields: [
        { custom_field_definition_id: 755332, value: 'SMB' }, // edited
        { custom_field_definition_id: 755333, value: 9.5 }, // unchanged
      ],
    };
    const result = compareFlattenedRecordVersions(flatten(working), flatten(original), flatten(original), 'acme.json');
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.row.__changedFields).toEqual([TIER]);
    // The "from" (approved) baseline for the popover is the original element value.
    expect(result.row.__fromFields[TIER]).toBe('Enterprise');
    expect(result.row.__rowStatus).toBe('modified');
  });

  it('flags both elements when both are edited', () => {
    const working = {
      id: 401,
      custom_fields: [
        { custom_field_definition_id: 755332, value: 'SMB' },
        { custom_field_definition_id: 755333, value: 1 },
      ],
    };
    const result = compareFlattenedRecordVersions(flatten(working), flatten(original), flatten(original), 'acme.json');
    expect(result?.row.__changedFields.sort()).toEqual([TIER, SCORE].sort());
  });

  it('marks an accepted-but-unpublished element edit as unpublished, not unreviewed', () => {
    // working === approved (dirty), both differ from master on the Tier element only.
    const edited = {
      id: 401,
      custom_fields: [
        { custom_field_definition_id: 755332, value: 'SMB' },
        { custom_field_definition_id: 755333, value: 9.5 },
      ],
    };
    const result = compareFlattenedRecordVersions(flatten(edited), flatten(edited), flatten(original), 'acme.json');
    expect(result?.row.__changedFields).toEqual([]);
    expect(result?.row.__unpublishedFields).toEqual([TIER]);
    expect(result?.row.__masterFields[TIER]).toBe('Enterprise');
  });
});
