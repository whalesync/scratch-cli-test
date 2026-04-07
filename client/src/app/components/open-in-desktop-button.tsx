'use client';

import { ButtonSecondaryGhost, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { trackClickOpenInDesktop } from '@/lib/posthog';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { desktopDeepLinkFromWebPath } from '@/utils/route-urls';
import { MonitorIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

export type OpenInDesktopButtonSection = 'toolbar' | 'workspace_connections';

export interface OpenInDesktopButtonProps {
  /**
   * Web path used to build scratch:// (e.g. `/workbook/id/files`, `/workspace/id/connections`).
   * When omitted, the current pathname is used.
   */
  webPathForDeepLink?: string;
  section?: OpenInDesktopButtonSection;
  variant?: 'ghost' | 'outline';
  children?: ReactNode;
}

export function OpenInDesktopButton({
  webPathForDeepLink,
  section = 'toolbar',
  variant = 'ghost',
  children = 'Open in Desktop',
}: OpenInDesktopButtonProps): ReactElement | null {
  const pathname = usePathname();
  const { user } = useScratchPadUser();

  if (!isExperimentEnabled('SHOW_OPEN_IN_DESKTOP', user)) {
    return null;
  }

  const path = webPathForDeepLink ?? pathname;
  if (!path) {
    return null;
  }
  const deepLink = desktopDeepLinkFromWebPath(path);
  if (!deepLink) {
    return null;
  }

  const icon = <StyledLucideIcon Icon={MonitorIcon} size="sm" />;
  const handleClick = (): void => {
    trackClickOpenInDesktop({ section });
    window.location.href = deepLink;
  };

  if (variant === 'outline') {
    return (
      <ButtonSecondaryOutline leftSection={icon} onClick={handleClick}>
        {children}
      </ButtonSecondaryOutline>
    );
  }

  return (
    <ButtonSecondaryGhost size="compact-sm" leftSection={icon} onClick={handleClick}>
      {children}
    </ButtonSecondaryGhost>
  );
}
