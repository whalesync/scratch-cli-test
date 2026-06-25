import { ScratchGitClient } from '../scratch-git.client';
import { ScratchGitService } from '../scratch-git.service';

const REPO_ID = 'org/wkb/coa';
const FOLDER_PATH = '/public/posts';
const SCHEMA_GIT_PATH = '.scratch/public/posts/schema.json';

/**
 * DEV-10092: `BaseJsonTableSpec`'s path-shaped fields were renamed/unified on the
 * `*Path: DotPath` (dot-path string) convention. `schema.json` files committed
 * before the rename still carry the legacy names (and segment-array shapes for
 * title/mainContent). `readSchemaFromGit` must normalize them on read so the
 * rest of the pull / publish pipeline only ever sees the new shape.
 */
describe('ScratchGitService.readSchemaFromGit — legacy path-field compat (DEV-10092)', () => {
  let service: ScratchGitService;
  let mockGetFile: jest.Mock;

  function buildService(schemaContent: Record<string, unknown>): ScratchGitService {
    mockGetFile = jest.fn().mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: JSON.stringify(schemaContent) });
      }
      return Promise.resolve(null);
    });
    const mockClient = { getFile: mockGetFile } as unknown as ScratchGitClient;
    return new ScratchGitService(mockClient, {} as never);
  }

  it('normalizes a legacy-shape schema.json to the new *Path fields', async () => {
    service = buildService({
      id: { wsId: 'public', remoteId: ['public', 'posts'] },
      slug: 'posts',
      name: 'posts',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      // Legacy names + legacy segment-array shapes (mirrors Attio / Webflow).
      idColumnRemoteId: 'id.record_id',
      titleColumnRemoteId: ['values', 'name'],
      mainContentColumnRemoteId: ['fields', 'content'],
      slugFieldPath: 'fieldData.slug',
    });

    const spec = await service.readSchemaFromGit(REPO_ID, FOLDER_PATH);

    expect(spec).not.toBeNull();
    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord.idPath).toBe('id.record_id');
    expect(asRecord.titlePath).toBe('values.name');
    expect(asRecord.mainContentPath).toBe('fields.content');
    expect(asRecord.slugPath).toBe('fieldData.slug');
    // Legacy keys are dropped so the returned object matches BaseJsonTableSpec.
    expect(asRecord.idColumnRemoteId).toBeUndefined();
    expect(asRecord.titleColumnRemoteId).toBeUndefined();
    expect(asRecord.mainContentColumnRemoteId).toBeUndefined();
    expect(asRecord.slugFieldPath).toBeUndefined();
  });

  it('passes a new-shape schema.json through unchanged (idempotent)', async () => {
    service = buildService({
      id: { wsId: 'public', remoteId: ['public', 'posts'] },
      slug: 'posts',
      name: 'posts',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      idPath: 'id',
      titlePath: 'fields.Name',
      slugPath: 'fields.slug',
    });

    const spec = await service.readSchemaFromGit(REPO_ID, FOLDER_PATH);

    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord.idPath).toBe('id');
    expect(asRecord.titlePath).toBe('fields.Name');
    expect(asRecord.slugPath).toBe('fields.slug');
  });

  it('prefers the new field when both new and legacy names are present', async () => {
    service = buildService({
      id: { wsId: 'public', remoteId: ['public', 'posts'] },
      slug: 'posts',
      name: 'posts',
      schema: { type: 'object', properties: {} },
      idPath: 'id',
      idColumnRemoteId: 'legacy_id',
    });

    const spec = await service.readSchemaFromGit(REPO_ID, FOLDER_PATH);

    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord.idPath).toBe('id');
    expect(asRecord.idColumnRemoteId).toBeUndefined();
  });

  it('keeps the deprecated slugColumnRemoteId fallback intact', async () => {
    service = buildService({
      id: { wsId: 'public', remoteId: ['public', 'posts'] },
      slug: 'posts',
      name: 'posts',
      schema: { type: 'object', properties: {} },
      idColumnRemoteId: 'id',
      slugColumnRemoteId: 'legacy.slug',
    });

    const spec = await service.readSchemaFromGit(REPO_ID, FOLDER_PATH);

    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord.idPath).toBe('id');
    expect(asRecord.slugColumnRemoteId).toBe('legacy.slug');
  });
});
