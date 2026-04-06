import { useCallback } from 'react';
import { isExperimentEnabled } from '../types/user';
import { useCurrentUser } from './use-current-user';

const LOCAL_STORAGE_KEY = 'dev_tools_visible';

function getDevToolsVisible(): boolean {
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function useDevTools() {
  const { user } = useCurrentUser();

  const toggleDevToolsVisible = useCallback(() => {
    if (user?.isAdmin) {
      const newValue = !getDevToolsVisible();
      localStorage.setItem(LOCAL_STORAGE_KEY, String(newValue));
    }
  }, [user]);

  return {
    isDevToolsEnabled: isExperimentEnabled('DEV_TOOLBOX', user) && getDevToolsVisible(),
    toggleDevToolsVisible,
    showSecretButton: user?.isAdmin,
  };
}
