import { useEffect, useState } from 'react';
import type { FieldValueDiffViewMode } from './field-value-types';

const DIFF_VIEW_MODE_STORAGE_KEY = 'scratch-desktop:field-value-diff-view-mode';
const DEFAULT_DIFF_VIEW_MODE: FieldValueDiffViewMode = 'inline-words';

function isDiffViewMode(value: unknown): value is FieldValueDiffViewMode {
  return value === 'side-by-side' || value === 'inline-words';
}

function readStoredDiffViewMode(): FieldValueDiffViewMode {
  if (typeof window === 'undefined') return DEFAULT_DIFF_VIEW_MODE;
  const stored = window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY);
  return isDiffViewMode(stored) ? stored : DEFAULT_DIFF_VIEW_MODE;
}

// Module-level pub/sub so a toggle in one panel propagates to all visible panels.
const diffViewModeSubscribers = new Set<(mode: FieldValueDiffViewMode) => void>();

function setSharedDiffViewMode(mode: FieldValueDiffViewMode) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
  }
  diffViewModeSubscribers.forEach((subscriber) => subscriber(mode));
}

export function useDiffViewMode(): [FieldValueDiffViewMode, (mode: FieldValueDiffViewMode) => void] {
  const [mode, setMode] = useState<FieldValueDiffViewMode>(readStoredDiffViewMode);
  useEffect(() => {
    diffViewModeSubscribers.add(setMode);
    return () => {
      diffViewModeSubscribers.delete(setMode);
    };
  }, []);
  return [mode, setSharedDiffViewMode];
}
