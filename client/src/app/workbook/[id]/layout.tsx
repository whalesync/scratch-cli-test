'use client';

import { FullPageLoader } from '@/app/components/FullPageLoader';
import { ErrorInfo, Info } from '@/app/components/InfoPanel';
import MainContent from '@/app/components/layouts/MainContent';
import { useWorkbook } from '@/hooks/use-workbook';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { useWorkbookWebSocketStore } from '@/stores/workbook-websocket-store';
import { RouteUrls } from '@/utils/route-urls';
import type { WorkbookId } from '@spinner/shared-types';
import { ArrowLeftIcon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { WorkbookLayout } from './components/WorkbookLayout';

interface LayoutProps {
  children: ReactNode;
}

export default function NewWorkbookLayout({ children }: LayoutProps) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workbookId = params.id as WorkbookId;

  const { workbook, isLoading, error } = useWorkbook(workbookId);
  const reset = useWorkbookUIStore((state) => state.reset);
  // Initialize the workbook editor store so useDataFolders can work
  const openWorkbook = useWorkbookUIStore((state) => state.openWorkbook);
  const closeWorkbook = useWorkbookUIStore((state) => state.closeWorkbook);
  const connect = useWorkbookWebSocketStore((state) => state.connect);
  const disconnect = useWorkbookWebSocketStore((state) => state.disconnect);

  // Initialize workbook editor store (just sets workbookId for useDataFolders to work)
  useEffect(() => {
    openWorkbook({ workbookId });
    connect(workbookId);

    return () => {
      closeWorkbook();
      reset();
      disconnect();
    };
  }, [workbookId, openWorkbook, closeWorkbook, reset, connect, disconnect]);

  if (isLoading && !workbook) {
    return <FullPageLoader message="Loading workspace..." />;
  }

  if (error || !workbook) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="" />
        <MainContent.Body>
          <ErrorInfo
            title="Workspace not found."
            description="We were unable to find the workspace you are looking for."
            action={
              <Info.ActionButton
                label="Return home"
                Icon={ArrowLeftIcon}
                onClick={() => router.push(RouteUrls.homePageUrl)}
              />
            }
          />
        </MainContent.Body>
      </MainContent>
    );
  }

  return <WorkbookLayout workbook={workbook}>{children}</WorkbookLayout>;
}
