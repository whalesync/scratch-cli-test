import { useMemo } from 'react';
import { useWorkspaceUiStore } from './workspace-ui-store';

/**
 * Resolves the currently selected record from the given rows by matching
 * `selectedRecordFilename` from the store. Returns null if no match is found.
 */
export function useSelectedRecord<T extends { __filename: string }>(rows: T[]): T | null {
  const selectedRecordFilename = useWorkspaceUiStore((s) => s.selectedRecordFilename);
  return useMemo(() => {
    if (!selectedRecordFilename) return null;
    return rows.find((r) => r.__filename === selectedRecordFilename) ?? null;
  }, [rows, selectedRecordFilename]);
}

/**
 * Resolves the index of the currently selected record within the given rows.
 * Returns null if no match is found.
 */
export function useSelectedRecordIndex<T extends { __filename: string }>(rows: T[]): number | null {
  const selectedRecordFilename = useWorkspaceUiStore((s) => s.selectedRecordFilename);
  return useMemo(() => {
    if (!selectedRecordFilename) return null;
    const idx = rows.findIndex((r) => r.__filename === selectedRecordFilename);
    return idx >= 0 ? idx : null;
  }, [rows, selectedRecordFilename]);
}
