import { BrowserWindow, screen } from 'electron';
import Store from 'electron-store';

interface WindowStateSchema {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  // null = never persisted, i.e. first launch
  isMaximized: boolean | null;
}

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const SAVE_DEBOUNCE_MS = 300;

const store = new Store<WindowStateSchema>({
  name: 'window-state',
  defaults: {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: null,
    y: null,
    isMaximized: null,
  },
});

export interface RestoredWindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  shouldMaximize: boolean;
}

export function getRestoredWindowState(): RestoredWindowState {
  const width = store.get('width');
  const height = store.get('height');
  const x = store.get('x');
  const y = store.get('y');
  const isMaximized = store.get('isMaximized');

  // First launch: open at default size and maximize, like Chrome.
  if (isMaximized === null) {
    return {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      x: null,
      y: null,
      shouldMaximize: true,
    };
  }

  // Subsequent launches: drop position if the stored window would land off-screen
  // (e.g. external monitor that's no longer connected).
  const positionVisible = x != null && y != null && isVisibleOnAnyDisplay({ x, y, width, height });

  return {
    width,
    height,
    x: positionVisible ? x : null,
    y: positionVisible ? y : null,
    shouldMaximize: isMaximized,
  };
}

function isVisibleOnAnyDisplay(rect: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return (
      rect.x < wa.x + wa.width && rect.x + rect.width > wa.x && rect.y < wa.y + wa.height && rect.y + rect.height > wa.y
    );
  });
}

export function attachWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null;

  const saveNow = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    store.set('width', bounds.width);
    store.set('height', bounds.height);
    store.set('x', bounds.x);
    store.set('y', bounds.y);
    store.set('isMaximized', window.isMaximized());
  };

  const saveDebounced = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };

  window.on('resize', saveDebounced);
  window.on('move', saveDebounced);
  window.on('maximize', saveNow);
  window.on('unmaximize', saveNow);
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveNow();
  });
}
