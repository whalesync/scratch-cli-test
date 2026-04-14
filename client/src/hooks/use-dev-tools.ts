import { isExperimentEnabled } from '@/types/server-entities/users';
import { FLAGS } from '@/utils/flags-dev';
import { useCallback } from 'react';
import { useScratchPadUser } from './useScratchpadUser';

export const useDevTools = () => {
  const { user, isImpersonating } = useScratchPadUser();

  const toggleDevToolsVisible = useCallback(() => {
    if (user?.isAdmin) {
      const newFlagValue = !FLAGS.DEV_TOOLS_VISIBLE.getLocalStorageValue();
      FLAGS.DEV_TOOLS_VISIBLE.setLocalStorageValue(newFlagValue);
    }
  }, [user]);

  return {
    isDevToolsEnabled:
      isImpersonating || (isExperimentEnabled('DEV_TOOLBOX', user) && FLAGS.DEV_TOOLS_VISIBLE.getLocalStorageValue()),
    toggleDevToolsVisible,
    showSecretButton: user?.isAdmin,
  };
};
