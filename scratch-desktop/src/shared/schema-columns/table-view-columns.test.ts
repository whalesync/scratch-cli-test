import type { TableView } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';

import { buildColumnDefinitions } from './build-column-definitions';
import { flattenTableViewColumns, tableViewColumnPaths } from './table-view-columns';

describe('flattenTableViewColumns', () => {
  it('inlines banner-group columns into a flat ordered list', () => {
    const view = {
      name: 'default',
      cols: [
        { kind: 'col', path: 'a', name: 'A', type: 'string' },
        { kind: 'banner-group', name: 'G', cols: [{ kind: 'col', path: 'b', name: 'B', type: 'string' }] },
        { kind: 'col', path: 'c', name: 'C', type: 'string' },
      ],
    } as unknown as TableView;

    expect(flattenTableViewColumns(view).map((c) => c.path)).toEqual(['a', 'b', 'c']);
  });
});

describe('tableViewColumnPaths', () => {
  it('returns ordered column paths, expanding banner groups', () => {
    const view = {
      name: 'default',
      cols: [
        { kind: 'col', path: 'properties.Name.title', name: 'Name', type: 'string' },
        {
          kind: 'banner-group',
          name: 'Details',
          cols: [
            { kind: 'col', path: 'properties.Asked for Intro?.checkbox', name: 'Asked for Intro?', type: 'checkbox' },
          ],
        },
      ],
    } as unknown as TableView;

    expect(tableViewColumnPaths(view)).toEqual(['properties.Name.title', 'properties.Asked for Intro?.checkbox']);
  });

  it('drills an enveloped property to its value leaf — unlike buildColumnDefinitions (the granularity that desynced the diff)', () => {
    // A Notion property is stored as an envelope carrying x-scratch metadata.
    const schema = {
      schema: {
        type: 'object',
        properties: {
          properties: {
            type: 'object',
            properties: {
              'Asked for Intro?': {
                type: 'object',
                'x-scratch-connector-data-type': 'checkbox',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  checkbox: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    };

    // buildColumnDefinitions treats the enveloped property as ONE leaf at the
    // ENVELOPE path (x-scratch metadata blocks recursion). That envelope path is
    // why __changedFields/focusColumnIds never matched the grid's leaf columns.
    const columnDefinitionIds = buildColumnDefinitions(schema).map((c) => c.id);
    expect(columnDefinitionIds).toContain('properties.Asked for Intro?');
    expect(columnDefinitionIds).not.toContain('properties.Asked for Intro?.checkbox');

    // The view (and therefore the diff, now that it is view-sourced) keys by the
    // drilled LEAF path, which matches the rendered column id.
    const view = {
      name: 'default',
      cols: [{ kind: 'col', path: 'properties.Asked for Intro?.checkbox', name: 'Asked for Intro?', type: 'checkbox' }],
    } as unknown as TableView;
    expect(tableViewColumnPaths(view)).toEqual(['properties.Asked for Intro?.checkbox']);
  });
});
