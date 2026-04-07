'use client';

import { SETTINGS_RETURN_PATH_STORAGE_KEY } from '@/utils/settings-return-path';
import { useSessionStorage } from '@mantine/hooks';

export function useSettingsReturnPathSessionStorage() {
  return useSessionStorage<string | null>({
    key: SETTINGS_RETURN_PATH_STORAGE_KEY,
    defaultValue: null,
  });
}
