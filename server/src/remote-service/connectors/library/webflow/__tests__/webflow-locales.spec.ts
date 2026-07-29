import { TObject } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import {
  findWebflowSecondaryLocaleByCmsLocaleId,
  webflowSecondaryLocaleBasePath,
  webflowSecondaryLocaleFolderName,
} from '../webflow-folder-paths';
import { buildWebflowJsonTableSpec } from '../webflow-json-schema';
import { WebflowSchemaParser } from '../webflow-schema-parser';
import { Collection, FieldType, Locale, Site } from '../webflow-types';

// DEV-10529 — secondary Webflow locales surfaced as nested per-locale tables.

const localeEs: Locale = {
  id: 'wf-locale-es',
  cmsLocaleId: 'cms-es',
  enabled: true,
  displayName: 'Spanish (Spain)',
  tag: 'es-ES',
  subdirectory: 'es',
};
const localeFr: Locale = { cmsLocaleId: 'cms-fr', enabled: true, tag: 'fr-FR' };

const site = {
  id: 'site-1',
  displayName: 'My Site',
  shortName: 'mysite',
  locales: {
    primary: { id: 'wf-locale-en', cmsLocaleId: 'cms-en', displayName: 'English' },
    secondary: [localeEs, localeFr],
  },
} as Site;

function makeCollection(displayName = 'Blog Posts', id = 'col-1'): Collection {
  return {
    id,
    displayName,
    slug: displayName.toLowerCase().replace(/\s+/g, '-'),
    fields: [],
  } as unknown as Collection;
}

/** A secondary-locale EntityId: remoteId = [siteId, collectionId, cmsLocaleId]. */
function localeTableId(cmsLocaleId: string, collId = 'col-1') {
  return { wsId: `${collId}_${cmsLocaleId}`, remoteId: ['site-1', collId, cmsLocaleId] };
}

describe('webflowSecondaryLocaleFolderName — display fallbacks', () => {
  it('prefers displayName', () => {
    expect(webflowSecondaryLocaleFolderName(localeEs)).toBe('Spanish (Spain)');
  });

  it('falls back to tag, then subdirectory, then cmsLocaleId, then id', () => {
    expect(webflowSecondaryLocaleFolderName({ cmsLocaleId: 'c', tag: 'fr-FR' })).toBe('fr-FR');
    expect(webflowSecondaryLocaleFolderName({ cmsLocaleId: 'c', subdirectory: 'de' })).toBe('de');
    expect(webflowSecondaryLocaleFolderName({ cmsLocaleId: 'c' })).toBe('c');
    expect(webflowSecondaryLocaleFolderName({ id: 'only-id' })).toBe('only-id');
  });
});

describe('webflowSecondaryLocaleBasePath — nests inside the primary collection', () => {
  it('v2 (nested): /<Site>/Collections/<Collection>', () => {
    expect(webflowSecondaryLocaleBasePath(site, 'Blog Posts', 2)).toEqual(['My Site', 'Collections', 'Blog Posts']);
  });

  it('v1 (flat): /<Site>/<Collection>', () => {
    expect(webflowSecondaryLocaleBasePath(site, 'Blog Posts', 1)).toEqual(['My Site', 'Blog Posts']);
  });
});

describe('findWebflowSecondaryLocaleByCmsLocaleId', () => {
  it('finds a secondary locale by cmsLocaleId', () => {
    expect(findWebflowSecondaryLocaleByCmsLocaleId(site, 'cms-fr')).toBe(localeFr);
  });

  it('returns undefined for an unknown or primary locale, or a site with no locales', () => {
    expect(findWebflowSecondaryLocaleByCmsLocaleId(site, 'cms-en')).toBeUndefined();
    expect(findWebflowSecondaryLocaleByCmsLocaleId(site, 'nope')).toBeUndefined();
    expect(findWebflowSecondaryLocaleByCmsLocaleId({ id: 's' } as Site, 'cms-es')).toBeUndefined();
  });
});

describe('buildWebflowJsonTableSpec — secondary-locale tables', () => {
  it('v2: nests the locale folder inside the primary collection and suffixes the title', () => {
    const spec = buildWebflowJsonTableSpec(localeTableId('cms-es'), site, makeCollection('Blog Posts'), 2);
    expect(spec.name).toBe('Spanish (Spain)');
    expect(spec.basePath).toEqual(['My Site', 'Collections', 'Blog Posts']);
    expect((spec.schema as TObject).title).toBe('Blog Posts (Spanish (Spain))');
    expect(spec.structureVersion).toBe(2);
  });

  it('v1: nests directly under the flat collection folder', () => {
    const spec = buildWebflowJsonTableSpec(localeTableId('cms-es'), site, makeCollection('Blog Posts'), 1);
    expect(spec.basePath).toEqual(['My Site', 'Blog Posts']);
    expect(spec.name).toBe('Spanish (Spain)');
  });

  it('keeps the schema $id as the bare collection id so references resolve across locales', () => {
    const primary = buildWebflowJsonTableSpec({ wsId: 'c', remoteId: ['site-1', 'col-1'] }, site, makeCollection(), 2);
    const localeSpec = buildWebflowJsonTableSpec(localeTableId('cms-es'), site, makeCollection(), 2);
    expect((localeSpec.schema as TObject).$id).toBe('col-1');
    expect((localeSpec.schema as TObject).$id).toBe((primary.schema as TObject).$id);
  });

  it('falls back to the cmsLocaleId when the locale is no longer on the site', () => {
    const spec = buildWebflowJsonTableSpec(localeTableId('cms-gone'), site, makeCollection('Blog Posts'), 2);
    expect(spec.name).toBe('cms-gone');
    expect(spec.basePath).toEqual(['My Site', 'Collections', 'Blog Posts']);
  });

  it('primary tables (no cmsLocaleId) are unchanged', () => {
    const spec = buildWebflowJsonTableSpec({ wsId: 'c', remoteId: ['site-1', 'col-1'] }, site, makeCollection(), 2);
    expect(spec.name).toBe('Blog Posts');
    expect(spec.basePath).toEqual(['My Site', 'Collections']);
    expect((spec.schema as TObject).title).toBe('Blog Posts');
  });

  it('carries the source locale segment in a reference FK linkedTableRemoteId', () => {
    // The linked collection's secondary-locale table has remoteId [siteId, refCollectionId, cmsLocaleId]
    // (parseSecondaryLocaleTablePreview), so a FK on a secondary-locale source table must include the
    // same locale segment to deep-equal it.
    const collectionWithRef = {
      id: 'col-1',
      displayName: 'Blog Posts',
      slug: 'blog-posts',
      fields: [
        {
          id: 'f-author',
          type: FieldType.Reference,
          slug: 'author',
          displayName: 'Author',
          isRequired: true,
          validations: { collectionId: 'col-authors' },
        },
      ],
    } as unknown as Collection;
    const spec = buildWebflowJsonTableSpec(localeTableId('cms-es'), site, collectionWithRef, 2);
    const fieldData = (spec.schema as TObject).properties.fieldData as TObject;
    const author = (fieldData.properties as Record<string, Record<string, unknown>>).author;
    expect(author[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'col-authors',
      linkedTableRemoteId: ['site-1', 'col-authors', 'cms-es'],
    });
  });
});

describe('WebflowSchemaParser.parseSecondaryLocaleTablePreview', () => {
  const parser = new WebflowSchemaParser();

  it('builds a 3-element remoteId and groups under the primary collection (v2)', () => {
    const preview = parser.parseSecondaryLocaleTablePreview(site, makeCollection('Blog Posts'), localeEs, 2);
    expect(preview.id.remoteId).toEqual(['site-1', 'col-1', 'cms-es']);
    expect(preview.displayName).toBe('Spanish (Spain)');
    expect(preview.parentPath).toBe('My Site/Collections/Blog Posts');
  });

  it('disables creates and deletes (localized variants follow the primary item)', () => {
    const preview = parser.parseSecondaryLocaleTablePreview(site, makeCollection(), localeEs, 2);
    expect(preview.disabledCreates).toBe(true);
    expect(preview.disabledDeletes).toBe(true);
    expect(preview.disabledUpdates).toBeUndefined();
    expect(preview.disabledReason).toMatch(/secondary locale/i);
  });

  it('carries the cmsLocaleId in metadata and a unique wsId', () => {
    const preview = parser.parseSecondaryLocaleTablePreview(site, makeCollection(), localeEs, 2);
    expect(preview.metadata).toMatchObject({ cmsLocaleId: 'cms-es', localeName: 'Spanish (Spain)' });
    expect(preview.id.wsId).toBe('col_1_cms_es');
  });
});
