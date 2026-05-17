'use client';

import { RouteUrls } from '@/utils/route-urls';
import { usePathname } from 'next/navigation';
import { ReportABugModal } from './modals/ReportABugModal';

export function AuthedOnlyModals() {
  const pathname = usePathname();
  if (RouteUrls.isPublicRoute(pathname)) return null;
  return <ReportABugModal />;
}
