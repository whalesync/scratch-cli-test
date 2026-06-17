'use client';

import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { RoutineEditor } from '../../components/MainPane/RoutineEditor';

export default function RoutineDetailPage() {
  const params = useParams<{ id: string; fileName: string }>();
  const workbookId = params.id as WorkbookId;

  return <RoutineEditor workbookId={workbookId} fileName={params.fileName} />;
}
