'use client';

import { useSettingsReturnPathSessionStorage } from '@/hooks/use-settings-return-path-session-storage';
import { isUnderSettingsPath, safePathForSettingsReturnStorage } from '@/utils/settings-return-path';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Records the last in-app path before navigating into /settings so Settings can offer a true "exit" target.
 */
export function SettingsReturnPathTracker() {
  const pathname = usePathname();
  const prevPathnameRef = useRef<string | null>(null);
  const [, setReturnPath] = useSettingsReturnPathSessionStorage();

  useEffect(() => {
    const prev = prevPathnameRef.current;
    if (prev !== null && !isUnderSettingsPath(prev) && isUnderSettingsPath(pathname)) {
      const toStore = safePathForSettingsReturnStorage(prev);
      if (toStore !== null) {
        setReturnPath(toStore);
      }
    }
    prevPathnameRef.current = pathname;
  }, [pathname, setReturnPath]);

  return null;
}
