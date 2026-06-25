import { beforeEach, describe, expect, it, vi } from 'vitest';

// electron-store reads/writes a JSON file keyed by `name`; back it with an
// in-memory object so we can assert the default-on rule without touching disk.
let mockStoreData: Record<string, unknown> = {};
vi.mock('electron-store', () => ({
  default: class {
    get(key: string): unknown {
      return mockStoreData[key];
    }
    set(key: string, value: unknown): void {
      mockStoreData[key] = value;
    }
  },
}));

describe('isAutoDownloadEnabled (DEV-10470 default-on)', () => {
  beforeEach(() => {
    mockStoreData = { currentWorkspaceId: null, workbookSettings: {} };
  });

  it('is ON when the workbook has no settings at all', async () => {
    const { isAutoDownloadEnabled } = await import('../preferences-store');
    expect(isAutoDownloadEnabled('wb-new')).toBe(true);
  });

  it('is ON when autoDownloadEnabled is undefined (other settings present)', async () => {
    mockStoreData = { currentWorkspaceId: null, workbookSettings: { 'wb-1': { validateEnabled: true } } };
    const { isAutoDownloadEnabled } = await import('../preferences-store');
    expect(isAutoDownloadEnabled('wb-1')).toBe(true);
  });

  it('is OFF only when explicitly set to false', async () => {
    mockStoreData = { currentWorkspaceId: null, workbookSettings: { 'wb-1': { autoDownloadEnabled: false } } };
    const { isAutoDownloadEnabled } = await import('../preferences-store');
    expect(isAutoDownloadEnabled('wb-1')).toBe(false);
  });

  it('is ON when explicitly set to true', async () => {
    mockStoreData = { currentWorkspaceId: null, workbookSettings: { 'wb-1': { autoDownloadEnabled: true } } };
    const { isAutoDownloadEnabled } = await import('../preferences-store');
    expect(isAutoDownloadEnabled('wb-1')).toBe(true);
  });
});
