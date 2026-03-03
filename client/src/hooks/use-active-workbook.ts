import { useNewWorkbookUIStore } from '@/stores/new-workbook-ui-store';
import { useWorkbook, UseWorkbookReturn } from './use-workbook';

/**
 * Hook for the active workbook in the editor UI so components don't have to pass the workbook ID around.
 * Generally use this instead of useWorkbook directly as it will handle the context for you
 *
 * Global UI state is managed in the WorkbookEditorUIStore. This wraps that to provide the data from SWR that is referenced
 * by the UI state.
 */
export const useActiveWorkbook = (): UseWorkbookReturn => {
  const workbookId = useNewWorkbookUIStore((state) => state.workbookId);
  const hookResult = useWorkbook(workbookId);
  return {
    ...hookResult,
  };
};
