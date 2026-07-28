import type { TableViewCol } from '@spinner/shared-types';
import { applyDisplayTransformer } from '@spinner/shared-types/transform';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import { EntityId } from '../../../types';
import { buildFramerDefaultView } from '../framer-default-view';
import { buildFramerJsonTableSpec } from '../framer-json-schema';
import { FramerCollectionMeta } from '../framer-types';

/**
 * The Framer field types whose stored value is a STRUCTURE — an asset object, or a list of
 * nested sub-item records — plus the two date shapes. These are the columns that used to
 * export as raw JSON blobs / date-only values (DEV-11086, DEV-11087, DEV-11088).
 */
const COLLECTION: FramerCollectionMeta = {
  id: 'col_qa',
  name: 'QA Main',
  fields: [
    { id: 'fTitle', name: 'Title', type: 'string' },
    { id: 'fPublishedAt', name: 'Published At', type: 'date', displayTime: true },
    { id: 'fDateOnly', name: 'Date Only', type: 'date', displayTime: false },
    { id: 'fDateUnknown', name: 'Date Unknown', type: 'date' },
    { id: 'fHeroImage', name: 'Hero Image', type: 'image' },
    { id: 'fAttachment', name: 'Attachment', type: 'file' },
    { id: 'fGallery', name: 'Gallery', type: 'array' },
  ],
};

const SPEC = buildFramerJsonTableSpec({ wsId: 'col_qa', remoteId: ['col_qa'] } as EntityId, COLLECTION);

/** The asset object Framer's Server API returns for an `image` field. */
const HERO_IMAGE_ASSET_VALUE = {
  id: 'pIlMJFwrlGSJRbMAl1Kjklus3vY.jpg',
  url: 'https://framerusercontent.com/images/pIlMJFwrlGSJRbMAl1Kjklus3vY.jpg',
  thumbnailUrl: 'https://framerusercontent.com/images/pIlMJFwrlGSJRbMAl1Kjklus3vY.jpg?scale-down-to=512',
  altText: '',
  resolution: 'auto',
};

/** A two-image `array` (gallery) value — each sub-item is a mini record keyed by a sub-field id. */
const GALLERY_VALUE = [
  {
    id: 'oraHwE0Qo',
    fieldData: {
      dafPhGolm: { type: 'image', value: { id: 'a.jpg', url: 'https://framerusercontent.com/images/a.jpg' } },
    },
  },
  {
    id: 'bQ4tLmXeR',
    fieldData: {
      dafPhGolm: { type: 'image', value: { id: 'b.jpg', url: 'https://framerusercontent.com/images/b.jpg' } },
    },
  },
];

function columnAt(path: string): TableViewCol {
  const view = buildFramerDefaultView(SPEC);
  const col = view.cols.find((entry): entry is TableViewCol => entry.kind === 'col' && entry.path === path);
  if (!col) throw new Error(`No column at ${path}`);
  return col;
}

/** The column's display transformer, asserting it has one (keeps the tests free of `!`). */
function displayTransformerAt(path: string): NonNullable<TableViewCol['displayTransformer']> {
  const displayTransformer = columnAt(path).displayTransformer;
  if (!displayTransformer) throw new Error(`No displayTransformer on the column at ${path}`);
  return displayTransformer;
}

/** The create-field type the schema-builder would give this column's destination field. */
function createFieldTypeFor(path: string) {
  const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
    schema: SPEC.schema,
    view: buildFramerDefaultView(SPEC),
    titlePath: SPEC.titlePath,
    idPath: SPEC.idPath,
  });
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path}`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'Framer');
}

describe('Framer asset (image/file) columns — DEV-11087', () => {
  it.each([
    ['fieldData.fHeroImage.value', 'image'],
    ['fieldData.fAttachment.value', 'file'],
  ])('flattens the %s asset object to its URL for display and export', (path) => {
    const col = columnAt(path);
    // Rendered through the text cell — the only cell kind that consults a displayTransformer.
    expect(col.type).toBe('string');
    // …but the value it really holds is a URL, which is what the destination field is created as.
    expect(col.logicalType).toBe('url');
    expect(col.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$.url', arrayHandling: 'first' },
    });
  });

  it('renders the asset URL rather than the raw JSON blob', () => {
    expect(applyDisplayTransformer(displayTransformerAt('fieldData.fHeroImage.value'), HERO_IMAGE_ASSET_VALUE)).toEqual(
      {
        ok: true,
        value: 'https://framerusercontent.com/images/pIlMJFwrlGSJRbMAl1Kjklus3vY.jpg',
      },
    );
  });

  it('creates a real URL column on the destination instead of downgrading to text', () => {
    expect(createFieldTypeFor('fieldData.fHeroImage.value')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'url' },
    });
  });
});

describe('Framer array (gallery) column — DEV-11088', () => {
  it('flattens the nested sub-items to their asset URLs', () => {
    const col = columnAt('fieldData.fGallery.value');
    expect(col.type).toBe('string');
    // No logicalType: many URLs joined into one value IS a string.
    expect(col.logicalType).toBeUndefined();
    expect(col.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].fieldData.*.value.url', arrayHandling: 'join_comma' },
    });
  });

  it('keeps EVERY image, not just the first — the value stays single so no destination collapses it', () => {
    expect(applyDisplayTransformer(displayTransformerAt('fieldData.fGallery.value'), GALLERY_VALUE)).toEqual({
      ok: true,
      value: 'https://framerusercontent.com/images/a.jpg, https://framerusercontent.com/images/b.jpg',
    });
  });

  it('shows an empty gallery as blank', () => {
    expect(applyDisplayTransformer(displayTransformerAt('fieldData.fGallery.value'), [])).toEqual({
      ok: true,
      value: '',
    });
  });

  it('falls back to the raw value when a sub-item has no asset URL to pluck', () => {
    const galleryWithABrokenSubItem = [GALLERY_VALUE[0], { id: 'noAsset', fieldData: {} }];
    expect(
      applyDisplayTransformer(displayTransformerAt('fieldData.fGallery.value'), galleryWithABrokenSubItem),
    ).toEqual({ ok: false });
  });
});

describe('Framer date columns — DEV-11086', () => {
  it('creates a destination column that keeps the time-of-day', () => {
    expect(createFieldTypeFor('fieldData.fPublishedAt.value')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date', includesTime: true },
    });
  });

  it('keeps the time-of-day when Framer does not report a displayTime for the field at all', () => {
    expect(createFieldTypeFor('fieldData.fDateUnknown.value')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date', includesTime: true },
    });
  });

  it('creates a date-only column for a field Framer reports as not displaying time', () => {
    expect(createFieldTypeFor('fieldData.fDateOnly.value')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date' },
    });
  });
});
