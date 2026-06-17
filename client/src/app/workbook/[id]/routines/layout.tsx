'use client';

import { useDevTools } from '@/hooks/use-dev-tools';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Routines ship behind the dev-tools gate for now (DEV-10446). This guards direct navigation to
 * `/workbook/:id/routines/*` — the tab itself is already hidden when dev tools are off.
 */
export default function RoutinesLayout({ children }: { children: ReactNode }) {
  const { isLoading } = useScratchPadUser();
  const { isDevToolsEnabled } = useDevTools();

  // Wait for the user to load before deciding, so a dev with the flag on never flashes a 404.
  if (isLoading) {
    return null;
  }
  if (!isDevToolsEnabled) {
    notFound();
  }
  return <>{children}</>;
}
