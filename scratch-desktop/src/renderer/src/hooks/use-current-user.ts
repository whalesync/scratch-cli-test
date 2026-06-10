import type { User } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';
import { usersApi } from '../lib/users-api';
import { UserSetting, UserSettingValue } from '../types/user';

const SWR_KEY = '/users/current';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface CurrentUser {
  user: User | null;
  isLoading: boolean;
  error: Error | undefined;
  refreshUser: () => Promise<void>;
  updateUserSetting: (key: UserSetting, value: UserSettingValue) => Promise<void>;
  getUserSetting: (key: UserSetting, defaultValue?: UserSettingValue) => UserSettingValue | null;
}

export function useCurrentUser(): CurrentUser {
  const { data, isLoading, error, mutate } = useSWR<User, Error>(SWR_KEY, usersApi.currentUser, {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: true,
  });

  const refreshUser = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const updateUserSetting = useCallback(
    async (key: UserSetting, value: UserSettingValue) => {
      if (!data) return;
      await usersApi.updateSettings({ [key]: value });
      await mutate();
    },
    [data, mutate],
  );

  const getUserSetting = useCallback(
    (key: UserSetting, defaultValue?: UserSettingValue) => {
      return data?.settings?.[key] ?? defaultValue ?? null;
    },
    [data],
  );

  return {
    user: data ?? null,
    isLoading,
    error,
    refreshUser,
    updateUserSetting,
    getUserSetting,
  };
}
