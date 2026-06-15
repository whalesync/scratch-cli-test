import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildWebflowPagesJsonTableSpec } from '../webflow-json-schema';
import { Site } from '../webflow-types';

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    displayName: 'My Site',
    shortName: 'mysite',
    ...overrides,
  } as Site;
}

describe('buildWebflowPagesJsonTableSpec', () => {
  const site = makeSite();
  const id = { wsId: '__pages__site-1', remoteId: ['site-1', '__pages__site-1'] };
  const spec = buildWebflowPagesJsonTableSpec(id, site);

  it('should set the table name to Pages', () => {
    expect(spec.name).toBe('Pages');
  });

  it('should use the id column for idColumnRemoteId', () => {
    expect(spec.idColumnRemoteId).toBe('id');
  });

  it('should use the slug column for titleColumnRemoteId', () => {
    expect(spec.titleColumnRemoteId).toEqual(['slug']);
  });

  it('should set basePath from site displayName', () => {
    expect(spec.basePath).toEqual(['My Site']);
  });

  it('should include a default view', () => {
    expect(spec.defaultView).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(spec.defaultView!.name).toBe('Default');
  });

  describe('schema properties', () => {
    const props = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;

    it('should include id field', () => {
      expect(props.id).toBeDefined();
    });

    it('should include title field', () => {
      expect(props.title).toBeDefined();
    });

    it('should include slug field', () => {
      expect(props.slug).toBeDefined();
    });

    it('should include publishedPath field', () => {
      expect(props.publishedPath).toBeDefined();
    });

    it('should include seo object field', () => {
      expect(props.seo).toBeDefined();
    });

    it('should include openGraph object field', () => {
      expect(props.openGraph).toBeDefined();
    });

    it('should not include nodes field', () => {
      expect(props.nodes).toBeUndefined();
    });

    it('should mark id as readonly', () => {
      expect((props.id as Record<string, unknown>)[X_SCRATCH_READONLY]).toBe(true);
    });

    it('should not mark title as readonly', () => {
      expect((props.title as Record<string, unknown>)[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('should not mark slug as readonly', () => {
      expect((props.slug as Record<string, unknown>)[X_SCRATCH_READONLY]).toBeUndefined();
    });

    // T7 (DEV-9698): the SEO metadata customers asked to edit. The Webflow Data
    // API exposes exactly these writable SEO fields — no Open Graph image,
    // canonical URL, or search-visibility/noindex toggle exists in the API
    // (those are Designer-only). These assertions pin that the full editable
    // SEO surface stays present and editable end-to-end.
    describe('SEO + Open Graph editable surface', () => {
      const subProps = (field: unknown): Record<string, Record<string, unknown>> =>
        (field as { properties: Record<string, Record<string, unknown>> }).properties;

      it('should expose editable seo.title and seo.description', () => {
        const seo = subProps(props.seo);
        expect(seo.title).toBeDefined();
        expect(seo.description).toBeDefined();
        expect(seo.title[X_SCRATCH_READONLY]).toBeUndefined();
        expect(seo.description[X_SCRATCH_READONLY]).toBeUndefined();
      });

      it('should expose editable openGraph title/description and their copied flags', () => {
        const og = subProps(props.openGraph);
        for (const key of ['title', 'titleCopied', 'description', 'descriptionCopied']) {
          expect(og[key]).toBeDefined();
          expect(og[key][X_SCRATCH_READONLY]).toBeUndefined();
        }
      });

      it.each(['publishedPath', 'parentId', 'archived', 'draft', 'createdOn', 'lastUpdated'])(
        'should mark the read-only metadata field %s as readonly',
        (field) => {
          expect((props[field] as Record<string, unknown>)[X_SCRATCH_READONLY]).toBe(true);
        },
      );
    });
  });
});
