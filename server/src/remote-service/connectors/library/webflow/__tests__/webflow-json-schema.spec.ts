import { TObject } from '@sinclair/typebox';
import {
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
} from '@spinner/shared-types';
import {
  buildWebflowAssetsJsonTableSpec,
  buildWebflowJsonTableSpec,
  getForeignKeyOptions,
  isReadonlyField,
} from '../webflow-json-schema';
import { Collection, FieldType, Site } from '../webflow-types';

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite' } as Site;

// A collection exercising the field types that the verbatim Webflow API returns as
// `null` when unset: an optional scalar, a MultiReference (foreign key), an Image
// (asset), plus a required field and a read-only field. (DEV-10453)
const collection = {
  id: 'col-1',
  displayName: 'Team Members',
  slug: 'team-members',
  fields: [
    { id: 'f-name', type: FieldType.PlainText, slug: 'name', displayName: 'Name', isRequired: true },
    { id: 'f-summary', type: FieldType.PlainText, slug: 'summary', displayName: 'Summary', isRequired: false },
    { id: 'f-priority', type: FieldType.Number, slug: 'priority', displayName: 'Priority', isRequired: false },
    {
      id: 'f-category',
      type: FieldType.MultiReference,
      slug: 'category',
      displayName: 'Categories',
      isRequired: false,
      validations: { collectionId: 'col-cats' },
    },
    {
      id: 'f-photo',
      type: FieldType.Image,
      slug: 'profile-picture',
      displayName: 'Profile Picture',
      isRequired: false,
    },
    {
      id: 'f-internal',
      type: FieldType.PlainText,
      slug: 'internal-note',
      displayName: 'Internal Note',
      isRequired: false,
      isEditable: false,
    },
  ],
} as Collection;

const spec = buildWebflowJsonTableSpec({ wsId: 'col-1ws', remoteId: ['site-1', 'col-1'] }, site, collection);
const fieldData = (spec.schema as TObject).properties.fieldData as TObject;
const fields = fieldData.properties as Record<string, Record<string, unknown>>;

function anyOf(field: Record<string, unknown>): Array<Record<string, unknown>> {
  return field.anyOf as Array<Record<string, unknown>>;
}

describe('buildWebflowJsonTableSpec — optional fields accept null (DEV-10453)', () => {
  it('makes an optional scalar field a nullable union, excluded from required', () => {
    const branches = anyOf(fields.summary);
    expect(branches).toHaveLength(2);
    expect(branches[0].type).toBe('string');
    expect(branches.some((m) => m.type === 'null')).toBe(true);
    expect(fieldData.required ?? []).not.toContain('summary');
  });

  it('makes an optional Number field nullable (fixes "null is not of type integer")', () => {
    expect(anyOf(fields.priority).some((m) => m.type === 'null')).toBe(true);
  });

  it('keeps required fields non-nullable and in the required array', () => {
    expect(fields.name.type).toBe('string');
    expect(fields.name.anyOf).toBeUndefined();
    expect(fieldData.required).toContain('name');
  });

  it('hoists x-scratch-* annotations + description onto the union (top level)', () => {
    expect(fields.summary.description).toBe('Summary');
    expect(fields.summary[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('PlainText');
  });

  it('makes a MultiReference nullable while keeping its foreign-key annotation', () => {
    const branches = anyOf(fields.category);
    const arrayBranch = branches.find((m) => m.type === 'array') as { items?: { type?: string } };
    expect(arrayBranch?.items?.type).toBe('string');
    expect(branches.some((m) => m.type === 'null')).toBe(true);
    expect(fields.category[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('MultiReference');
    // The linked collection lives in the same site, so its full remoteId is [siteId, refCollectionId]
    // (matching how listTables builds a primary collection's remoteId).
    expect(fields.category[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'col-cats',
      linkedTableRemoteId: ['site-1', 'col-cats'],
    });
    // The pointer-based lookup the frontends use still resolves the FK.
    expect(getForeignKeyOptions('category', spec)).toEqual({
      linkedTableId: 'col-cats',
      linkedTableRemoteId: ['site-1', 'col-cats'],
    });
  });

  it('makes an Image field nullable while keeping its asset annotation', () => {
    const photo = fields['profile-picture'];
    expect(anyOf(photo).some((m) => m.type === 'null')).toBe(true);
    expect(photo[X_SCRATCH_ASSET_FIELD]).toEqual({ idPath: 'fileId', urlExpires: false });
  });

  it("makes the Image object's alt and fileId accept null (fixes the alt error)", () => {
    const photo = fields['profile-picture'];
    const imageObject = anyOf(photo).find((m) => m.type === 'object') as {
      properties: Record<string, { anyOf?: Array<{ type?: string }>; type?: string }>;
    };
    expect(imageObject.properties.alt.anyOf?.some((m) => m.type === 'null')).toBe(true);
    expect(imageObject.properties.fileId.anyOf?.some((m) => m.type === 'null')).toBe(true);
    // url stays a non-null string (always present when the asset is).
    expect(imageObject.properties.url.type).toBe('string');
  });

  it('keeps read-only detection working through the nullable union', () => {
    expect(fields['internal-note'].anyOf).toBeDefined();
    expect(isReadonlyField('internal-note', spec)).toBe(true);
  });
});

describe('buildWebflowJsonTableSpec — VideoLink models the oEmbed object (not a bare URL)', () => {
  // Webflow's "Video Link" field returns an enriched oEmbed object, e.g.
  // { url, metadata: { html, title, thumbnail_url, … } } — not a bare URL string.
  const videoCollection = {
    id: 'col-vid',
    displayName: 'Solutions',
    slug: 'solutions',
    fields: [
      { id: 'f-name', type: FieldType.PlainText, slug: 'name', displayName: 'Name', isRequired: true },
      {
        id: 'f-video',
        type: FieldType.VideoLink,
        slug: 'overview-video',
        displayName: 'Overview Video',
        isRequired: false,
      },
    ],
  } as Collection;
  const videoSpec = buildWebflowJsonTableSpec(
    { wsId: 'col-vidws', remoteId: ['site-1', 'col-vid'] },
    site,
    videoCollection,
  );
  const videoFields = ((videoSpec.schema as TObject).properties.fieldData as TObject).properties as Record<
    string,
    Record<string, unknown>
  >;

  it('accepts the oEmbed object { url, metadata } Webflow returns, still nullable', () => {
    const branches = anyOf(videoFields['overview-video']);
    expect(branches.some((m) => m.type === 'null')).toBe(true);
    const nonNull = branches.find((m) => Array.isArray(m.anyOf)) as { anyOf: Array<Record<string, unknown>> };
    const objectBranch = nonNull.anyOf.find((m) => m.type === 'object') as {
      properties: Record<string, { type?: string; format?: string }>;
    };
    expect(objectBranch.properties.url.type).toBe('string');
    expect(objectBranch.properties.url.format).toBe('uri');
    expect('metadata' in objectBranch.properties).toBe(true);
    // A bare URI string is still accepted defensively (e.g. an unresolved embed).
    expect(nonNull.anyOf.some((m) => m.type === 'string' && m.format === 'uri')).toBe(true);
  });

  it('keeps the VideoLink connector-data-type annotation', () => {
    expect(videoFields['overview-video'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('VideoLink');
  });
});

describe('buildWebflowAssetsJsonTableSpec — optional fields accept null (DEV-10453)', () => {
  const assetsSpec = buildWebflowAssetsJsonTableSpec({ wsId: '__assets__site-1', remoteId: ['site-1'] }, site);
  const assetProps = (assetsSpec.schema as TObject).properties as Record<string, Record<string, unknown>>;
  const allowsNull = (field: Record<string, unknown>): boolean => {
    const union = field.anyOf as Array<{ type?: unknown }> | undefined;
    return Array.isArray(union) && union.some((m) => m.type === 'null');
  };

  it.each(['hostedUrl', 'originalFileName', 'contentType', 'size', 'altText', 'siteId', 'createdOn', 'lastUpdated'])(
    'asset field %s is nullable',
    (field) => {
      expect(allowsNull(assetProps[field])).toBe(true);
    },
  );

  it('keeps the asset-field annotation hoisted onto the nullable hostedUrl', () => {
    expect(assetProps.hostedUrl[X_SCRATCH_ASSET_FIELD]).toEqual({ idPath: null, urlExpires: false });
  });
});
