import { useWorkbookUIStore } from '../workbook-ui-store';

// Reset store between tests
beforeEach(() => {
  useWorkbookUIStore.getState().reset();
  localStorage.clear();
});

describe('toggleHiddenFiles', () => {
  it('toggles show hidden files for a connection', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();

    toggleHiddenFiles('conn-1');
    expect(useWorkbookUIStore.getState().showHiddenConnections.has('conn-1')).toBe(true);

    toggleHiddenFiles('conn-1');
    expect(useWorkbookUIStore.getState().showHiddenConnections.has('conn-1')).toBe(false);
  });

  it('tracks multiple connections independently', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();

    toggleHiddenFiles('conn-1');
    toggleHiddenFiles('conn-2');

    const state = useWorkbookUIStore.getState();
    expect(state.showHiddenConnections.has('conn-1')).toBe(true);
    expect(state.showHiddenConnections.has('conn-2')).toBe(true);

    toggleHiddenFiles('conn-1');
    const updated = useWorkbookUIStore.getState();
    expect(updated.showHiddenConnections.has('conn-1')).toBe(false);
    expect(updated.showHiddenConnections.has('conn-2')).toBe(true);
  });

  it('persists across store recreations via localStorage', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();
    toggleHiddenFiles('conn-1');

    // Verify localStorage contains the value
    const stored = localStorage.getItem('workbook-ui-store');
    expect(stored).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(stored!) as { state: { showHiddenConnections: string[] } };
    expect(parsed.state.showHiddenConnections).toContain('conn-1');
  });
});

describe('corrupt persisted state (DEV-9981)', () => {
  it('rehydrates without throwing and keeps the store usable when localStorage is truncated', async () => {
    // Simulate a partially-written / corrupt persisted blob.
    localStorage.setItem('workbook-ui-store', '{"state":{"expandedNodes":[');

    await expect(useWorkbookUIStore.persist.rehydrate()).resolves.not.toThrow();

    // The store falls back to its initial (valid) Set-typed state instead of crashing.
    const state = useWorkbookUIStore.getState();
    expect(state.expandedNodes).toBeInstanceOf(Set);
    expect(state.showHiddenConnections).toBeInstanceOf(Set);
    expect(state.hiddenFileFolders).toBeInstanceOf(Set);
  });

  it('rehydrates without throwing when localStorage holds valid JSON of the wrong shape', async () => {
    localStorage.setItem('workbook-ui-store', 'null');

    await expect(useWorkbookUIStore.persist.rehydrate()).resolves.not.toThrow();
    expect(useWorkbookUIStore.getState().expandedNodes).toBeInstanceOf(Set);
  });
});
