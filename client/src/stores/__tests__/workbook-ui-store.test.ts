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
    const parsed = JSON.parse(stored!) as { state: { showHiddenConnections: string[] } };
    expect(parsed.state.showHiddenConnections).toContain('conn-1');
  });
});
