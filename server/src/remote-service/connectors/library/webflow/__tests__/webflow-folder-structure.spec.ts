import {
  WEBFLOW_COLLECTIONS_FOLDER_SEGMENT,
  webflowCollectionBasePath,
  webflowSiteFolderName,
} from '../webflow-folder-paths';
import {
  buildWebflowAssetsJsonTableSpec,
  buildWebflowJsonTableSpec,
  buildWebflowPagesJsonTableSpec,
} from '../webflow-json-schema';
import { WebflowSchemaParser } from '../webflow-schema-parser';
import { Collection, Site } from '../webflow-types';

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite' } as Site;

function makeCollection(displayName: string, id = 'col-1'): Collection {
  return {
    id,
    displayName,
    slug: displayName.toLowerCase().replace(/\s+/g, '-'),
    fields: [],
  } as unknown as Collection;
}

function collectionId(id = 'col-1') {
  return { wsId: `${id}ws`, remoteId: ['site-1', id] };
}

describe('webflowCollectionBasePath (DEV-9698 shared helper)', () => {
  it('v1 (flat) → [siteName]', () => {
    expect(webflowCollectionBasePath(site, 1)).toEqual(['My Site']);
  });

  it('v2 (nested) → [siteName, "Collections"]', () => {
    expect(webflowCollectionBasePath(site, 2)).toEqual(['My Site', 'Collections']);
  });

  it('uses the shared Collections segment constant, never a literal', () => {
    expect(webflowCollectionBasePath(site, 2)[1]).toBe(WEBFLOW_COLLECTIONS_FOLDER_SEGMENT);
  });

  it('falls back to shortName, then empty string, for the site segment', () => {
    expect(webflowSiteFolderName({ id: 's', shortName: 'only-short' } as Site)).toBe('only-short');
    expect(webflowSiteFolderName({ id: 's' } as Site)).toBe('');
  });
});

describe('buildWebflowJsonTableSpec — version-pinned basePath', () => {
  it('v1 account: collection stays flat at /<Site>/ with structureVersion 1', () => {
    const spec = buildWebflowJsonTableSpec(collectionId(), site, makeCollection('Blog Posts'), 1);
    expect(spec.basePath).toEqual(['My Site']);
    expect(spec.structureVersion).toBe(1);
  });

  it('v2 account: collection nests under /<Site>/Collections/ with structureVersion 2', () => {
    const spec = buildWebflowJsonTableSpec(collectionId(), site, makeCollection('Blog Posts'), 2);
    expect(spec.basePath).toEqual(['My Site', 'Collections']);
    expect(spec.structureVersion).toBe(2);
  });

  it('defaults to v1 (flat) when no version is supplied', () => {
    const spec = buildWebflowJsonTableSpec(collectionId(), site, makeCollection('Blog Posts'));
    expect(spec.basePath).toEqual(['My Site']);
    expect(spec.structureVersion).toBe(1);
  });
});

describe('buildWebflow{Assets,Pages}JsonTableSpec — never nest', () => {
  it('Assets stays flat at /<Site>/ on both v1 and v2, stamping the account version', () => {
    const v1 = buildWebflowAssetsJsonTableSpec(collectionId(), site, 1);
    const v2 = buildWebflowAssetsJsonTableSpec(collectionId(), site, 2);
    expect(v1.basePath).toEqual(['My Site']);
    expect(v2.basePath).toEqual(['My Site']);
    expect(v1.structureVersion).toBe(1);
    expect(v2.structureVersion).toBe(2);
  });

  it('Pages stays flat at /<Site>/ on both v1 and v2, stamping the account version', () => {
    const v1 = buildWebflowPagesJsonTableSpec(collectionId(), site, 1);
    const v2 = buildWebflowPagesJsonTableSpec(collectionId(), site, 2);
    expect(v1.basePath).toEqual(['My Site']);
    expect(v2.basePath).toEqual(['My Site']);
    expect(v1.structureVersion).toBe(1);
    expect(v2.structureVersion).toBe(2);
  });
});

describe('collision-by-construction (DEV-9698): collection named "Assets"/"Pages"', () => {
  // The latent bug: a CMS collection named "Assets" collides with the synthetic
  // Assets table at /<Site>/Assets and gets an ugly -{id5} suffix. Nesting
  // collections under /Collections/ puts them in a disjoint namespace.
  it.each(['Assets', 'Pages'])('v2: a collection named "%s" lands in the disjoint Collections namespace', (name) => {
    const collectionSpec = buildWebflowJsonTableSpec(collectionId(), site, makeCollection(name), 2);
    const assetsSpec = buildWebflowAssetsJsonTableSpec(collectionId(), site, 2);
    const pagesSpec = buildWebflowPagesJsonTableSpec(collectionId(), site, 2);

    // collection: /My Site/Collections/<name> ; synthetic tables: /My Site/<name>
    expect(collectionSpec.basePath).toEqual(['My Site', 'Collections']);
    expect(assetsSpec.basePath).toEqual(['My Site']);
    expect(pagesSpec.basePath).toEqual(['My Site']);
    // No shared (basePath + name) tuple → ensureUniquePath never has to suffix.
    expect([...(collectionSpec.basePath ?? []), collectionSpec.name]).not.toEqual([
      ...(assetsSpec.basePath ?? []),
      assetsSpec.name,
    ]);
  });
});

describe('WebflowSchemaParser.parseTablePreview — picker grouping matches post-pull tree', () => {
  const parser = new WebflowSchemaParser();

  it('v1: groups collection previews under the site', () => {
    const preview = parser.parseTablePreview(site, makeCollection('Blog Posts'), 1);
    expect(preview.parentPath).toBe('My Site');
  });

  it('v2: groups collection previews under <Site>/Collections', () => {
    const preview = parser.parseTablePreview(site, makeCollection('Blog Posts'), 2);
    expect(preview.parentPath).toBe('My Site/Collections');
  });
});
