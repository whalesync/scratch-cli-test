'use client';

import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { RoutineEditor } from '../../components/MainPane/RoutineEditor';

export default function RoutineDetailPage() {
  const params = useParams<{ id: string; fileName: string }>();
  const workbookId = params.id as WorkbookId;

  // Keyed by file name so navigating to a different routine (or to "new") remounts the editor with fresh state.
  return <RoutineEditor key={params.fileName} workbookId={workbookId} fileName={params.fileName} />;
}
