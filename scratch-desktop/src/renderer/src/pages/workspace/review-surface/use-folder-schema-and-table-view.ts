import type { TableView } from '@spinner/shared-types';
import { useEffect, useRef, useState } from 'react';
import { createFallbackTableView } from '../../../../../shared/schema-columns';

/**
 * Loads a folder's JSON schema + `TableView` (the on-disk "default" view when present, else a
 * generated fallback) and keeps them fresh via the connection-file-changed hot-reload signal.
 * Lifted from `FolderDataGrid`'s metadata effects so `ReviewTableGrid`'s host reuses the exact
 * same view-resolution logic; unlike the v1 grid this surface owns no `visibleColumnIds`, so the
 * hot-reload path never resets column visibility.
 */
export interface FolderSchemaAndTableView {
  schema: Record<string, unknown> | null;
  tableView: TableView | null;
  availableViewNames: string[];
  /** `'default'` | `'Generated'` | a named on-disk view. Drives which view the hot-reload re-reads. */
  viewSource: string;
}

export function useFolderSchemaAndTableView(
  folderPath: string | null,
  workspacePath: string | null,
): FolderSchemaAndTableView {
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [tableView, setTableView] = useState<TableView | null>(null);
  const [availableViewNames, setAvailableViewNames] = useState<string[]>([]);
  const [viewSource, setViewSource] = useState<string>('Generated');

  // Mirror of the current view's JSON so the hot-reload path can skip a no-op `setTableView`
  // (many CLI commands re-copy an identical view file, firing the change signal spuriously).
  const tableViewJsonRef = useRef<string | null>(null);
  useEffect(() => {
    tableViewJsonRef.current = tableView ? JSON.stringify(tableView) : null;
  }, [tableView]);

  // Load schema + view when the folder changes.
  useEffect(() => {
    if (!folderPath || !workspacePath) {
      setSchema(null);
      setTableView(null);
      setViewSource('Generated');
      setAvailableViewNames([]);
      return;
    }
    let cancelled = false;
    void window.scratchFiles
      .getFolderMetadata(folderPath, workspacePath)
      .then((meta) => {
        if (cancelled) return;
        setSchema(meta.schema);
        setAvailableViewNames(meta.availableViewNames ?? []);
        // Use the on-disk "default" view if available; otherwise fall back to the generated view.
        const hasDefaultView = (meta.availableViewNames ?? []).includes('default');
        if (hasDefaultView && meta.view) {
          setTableView(meta.view);
          setViewSource('default');
        } else if (meta.schema) {
          setTableView(createFallbackTableView(meta.schema));
          setViewSource('Generated');
        } else {
          setTableView(null);
          setViewSource('Generated');
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load folder metadata:', err);
        if (cancelled) return;
        setSchema(null);
        setTableView(null);
        setViewSource('Generated');
        setAvailableViewNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath, workspacePath]);

  // Re-read schema + view from disk when a connection file changes (dev-time hot reload).
  useEffect(() => {
    if (!window.scratchDesktop?.onConnectionFileChanged) return;
    if (!folderPath || !workspacePath) return;

    const unsubscribe = window.scratchDesktop.onConnectionFileChanged(() => {
      void window.scratchFiles
        .getFolderMetadata(folderPath, workspacePath)
        .then((meta) => {
          setSchema(meta.schema);
          setAvailableViewNames(meta.availableViewNames ?? []);

          if (viewSource === 'Generated') {
            // Regenerate the fallback view from the (possibly updated) schema.
            setTableView(meta.schema ? createFallbackTableView(meta.schema) : null);
          } else {
            // Re-read the named view from disk, skipping the update when its content is unchanged.
            void window.scratchFiles
              .readConnectionView(folderPath, workspacePath, viewSource)
              .then((view) => {
                if (view && JSON.stringify(view) !== tableViewJsonRef.current) {
                  setTableView(view);
                }
              })
              .catch((err: unknown) => console.debug('Failed to reload view on file change:', err));
          }
        })
        .catch((err: unknown) => console.debug('Failed to reload folder metadata on file change:', err));
    });

    return unsubscribe;
  }, [viewSource, folderPath, workspacePath]);

  return { schema, tableView, availableViewNames, viewSource };
}
