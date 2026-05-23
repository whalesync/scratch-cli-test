import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapDeepLinkToDesktopRoute } from '../deep-link-routes';

const workspacePath = '/Users/chrishoefgen/Documents/ScratchWorkspaces/Improve Blogs FAQs';

beforeEach(() => {
  vi.stubGlobal('window', {
    scratchDesktop: {
      getWorkspacesRegistry: vi
        .fn()
        .mockResolvedValue([{ id: 'workspace-1', path: workspacePath, fileCount: 10, cloudSyncWarning: null }]),
    },
  });
});

describe('mapDeepLinkToDesktopRoute', () => {
  it('opens a local workspace folder from a valid scratch://open link', async () => {
    await expect(
      mapDeepLinkToDesktopRoute(
        'open',
        '?path=%2FUsers%2Fchrishoefgen%2FDocuments%2FScratchWorkspaces%2FImprove%20Blogs%20FAQs&source=claude-code',
      ),
    ).resolves.toMatch(/^\/workspace\/workspace-1\?source=claude-code&_dl=/);
  });
});
