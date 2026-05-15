'use client';

import { FullPageLoader } from '@/app/components/FullPageLoader';

/**
 * Root page. `ScratchPadUserProvider` always redirects `/` to either the
 * user's `lastWorkbookId` workbook or to `/workbook` (the picker), so this
 * page only paints briefly while navigation is in flight.
 */
export default function HomePage() {
  return <FullPageLoader />;
}
