import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { ALL_ENTITY_TYPES } from '../graphql';
import { ISSUES_QUERY_FIELDS } from '../graphql/schemas/issues.schema';
import { buildLinearJsonTableSpec } from '../linear-json-schema';

describe('buildLinearJsonTableSpec last-modified annotation', () => {
  function topLevelProps(entityType: string): Record<string, Record<string, unknown>> {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it.each([...ALL_ENTITY_TYPES])(
    'annotates the universal updatedAt system field with x-scratch-last-modified-field=true for %s',
    (entityType) => {
      expect(topLevelProps(entityType).updatedAt[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    },
  );

  it.each([...ALL_ENTITY_TYPES])('does not annotate the createdAt system field for %s', (entityType) => {
    expect(topLevelProps(entityType).createdAt[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it.each([...ALL_ENTITY_TYPES])('findLastModifiedFieldName resolves updatedAt for %s', (entityType) => {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    expect(findLastModifiedFieldName(spec)).toBe('updatedAt');
  });
});

describe('buildLinearJsonTableSpec markdown annotation', () => {
  function topLevelProps(entityType: string): Record<string, Record<string, unknown>> {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it('tags Issues.description with contentMediaType: text/markdown', () => {
    expect(topLevelProps('issues').description.contentMediaType).toBe('text/markdown');
  });

  it('tags Projects.description and Projects.content with contentMediaType: text/markdown', () => {
    const props = topLevelProps('projects');
    expect(props.description.contentMediaType).toBe('text/markdown');
    expect(props.content.contentMediaType).toBe('text/markdown');
  });
});

/**
 * These assert the shape the codegen config produces (`LINEAR_SCALAR_MAPPINGS.TimelessDate`,
 * `CYCLES_CONFIG.columns.title`), so a future regeneration that loses either is caught here rather
 * than in a Live Export run.
 */
describe('buildLinearJsonTableSpec TimelessDate format (DEV-11026)', () => {
  /** The `format` on the string branch of a nullable-string field, where date detection reads it. */
  function stringVariantFormat(entityType: string, fieldName: string): string | undefined {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    const props = (spec.schema as unknown as { properties: Record<string, { anyOf?: Record<string, unknown>[] }> })
      .properties;
    const stringVariant = props[fieldName].anyOf?.find((variant) => variant.type === 'string');
    return stringVariant?.format as string | undefined;
  }

  it.each([
    ['issues', 'dueDate'],
    ['projects', 'startDate'],
    ['projects', 'targetDate'],
  ])('annotates %s.%s with format: date', (entityType, fieldName) => {
    expect(stringVariantFormat(entityType, fieldName)).toBe('date');
  });

  it('leaves the non-date *Resolution siblings untouched', () => {
    expect(stringVariantFormat('projects', 'startDateResolution')).toBeUndefined();
    expect(stringVariantFormat('projects', 'targetDateResolution')).toBeUndefined();
  });

  it('leaves DateTime fields on format: date-time', () => {
    expect(stringVariantFormat('issues', 'createdAt')).toBe('date-time');
  });
});

describe('Issues query field selection', () => {
  it('pulls the workflow states displayable fields, not just its id (DEV-11024)', () => {
    expect(ISSUES_QUERY_FIELDS).toContain('state { id name type color position description }');
  });

  it.each(['team', 'project', 'cycle', 'assignee', 'creator', 'parent'])(
    'still pulls %s as an id-only reference — the default view links it by that id',
    (fieldName) => {
      expect(ISSUES_QUERY_FIELDS).toContain(`${fieldName} { id }`);
    },
  );
});

describe('buildLinearJsonTableSpec title paths', () => {
  function titlePathFor(entityType: string): string | undefined {
    return buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] }).titlePath;
  }

  it('titles Cycles by their text name, not their number, so the primary field is text (DEV-11025)', () => {
    expect(titlePathFor('cycles')).toBe('name');
  });

  it('keeps the Cycles slug on number so record filenames still fall back to it', () => {
    expect(buildLinearJsonTableSpec({ wsId: 'cycles', remoteId: ['cycles'] }).slugPath).toBe('number');
  });

  it.each([
    ['issues', 'title'],
    ['projects', 'name'],
    ['teams', 'name'],
    ['users', 'name'],
    ['labels', 'name'],
  ])('leaves the %s title path on %s', (entityType, expected) => {
    expect(titlePathFor(entityType)).toBe(expected);
  });
});
