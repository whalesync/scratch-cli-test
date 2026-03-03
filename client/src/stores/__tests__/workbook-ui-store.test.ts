import { useWorkbookUIStore } from '../workbook-ui-store';

// Reset store between tests
beforeEach(() => {
  useWorkbookUIStore.getState().reset();
  localStorage.clear();
});

describe('toggleHiddenFiles', () => {
  it('toggles hidden files for a folder', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();

    toggleHiddenFiles('folder-1');
    expect(useWorkbookUIStore.getState().hiddenFileFolders.has('folder-1')).toBe(true);

    toggleHiddenFiles('folder-1');
    expect(useWorkbookUIStore.getState().hiddenFileFolders.has('folder-1')).toBe(false);
  });

  it('tracks multiple folders independently', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();

    toggleHiddenFiles('folder-1');
    toggleHiddenFiles('folder-2');

    const state = useWorkbookUIStore.getState();
    expect(state.hiddenFileFolders.has('folder-1')).toBe(true);
    expect(state.hiddenFileFolders.has('folder-2')).toBe(true);

    toggleHiddenFiles('folder-1');
    const updated = useWorkbookUIStore.getState();
    expect(updated.hiddenFileFolders.has('folder-1')).toBe(false);
    expect(updated.hiddenFileFolders.has('folder-2')).toBe(true);
  });

  it('persists across store recreations via localStorage', () => {
    const { toggleHiddenFiles } = useWorkbookUIStore.getState();
    toggleHiddenFiles('folder-1');

    // Verify localStorage contains the value
    const stored = localStorage.getItem('workbook-ui-store');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.hiddenFileFolders).toContain('folder-1');
  });
});
