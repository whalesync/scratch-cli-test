import { API_CONFIG } from '@/lib/api/config';
import { SWR_KEYS } from '@/lib/api/keys';
import { usersApi } from '@/lib/api/users';
import { UserSetting, UserSettingValue } from '@/types/server-entities/users';
import { RouteUrls } from '@/utils/route-urls';
import { useAuth, useUser } from '@clerk/nextjs';
import { User } from '@spinner/shared-types';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface ScratchPadUser {
  isLoading: boolean;
  user: User | null;
  // Clerk doesn't expost the UserResource type anymore, so we use the useUser hook to get the user object
  clerkUser: ReturnType<typeof useUser>['user'] | null;
  signOut: () => void;
  isSignedIn?: boolean;
  isAdmin?: boolean;
  isImpersonating: boolean;
  updateUserSetting: (key: UserSetting, value: UserSettingValue) => Promise<void>;
  clearUserSetting: (key: UserSetting) => Promise<void>;
  getUserSetting: (key: UserSetting, defaultValue?: UserSettingValue) => UserSettingValue | null;
  refreshCurrentUser: () => Promise<void>;
}

export const useScratchPadUser = (): ScratchPadUser => {
  const { signOut, actor } = useAuth();
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  const {
    data: user,
    isLoading,
    mutate,
  } = useSWR(SWR_KEYS.users.activeUser(), usersApi.activeUser, {
    refreshInterval: 1000 * 60 * 5, // 5 minutes
    onSuccess: (data) => {
      /// update our static config when the values change
      if (data.websocketToken !== API_CONFIG.getSnapshotWebsocketToken()) {
        API_CONFIG.setSnapshotWebsocketToken(data.websocketToken || '');
      }
    },
  });

  const router = useRouter();

  const signOutClerk = useCallback(() => {
    /*
     * Clerk handles signouts with an async function and needs special treatment to call it
     */
    if (signOut) {
      // The Clerk singOut function is async
      const asyncSignOut = async (): Promise<void> => {
        await signOut();
      };
      asyncSignOut()
        .catch(console.error)
        .finally(() => router.push(RouteUrls.signInPageUrl));
    }
  }, [router, signOut]);

  const updateUserSetting = useCallback(
    async (key: UserSetting, value: string | number | boolean) => {
      if (!user) {
        return;
      }

      await usersApi.updateSettings({
        updates: {
          [key]: value,
        },
      });

      await mutate();
    },
    [user, mutate],
  );

  const clearUserSetting = useCallback(
    async (key: UserSetting) => {
      if (!user) {
        return;
      }

      await usersApi.updateSettings({
        updates: {
          [key]: null,
        },
      });

      mutate();
    },
    [user, mutate],
  );

  const getUserSetting = useCallback(
    (key: UserSetting, defaultValue?: UserSettingValue) => {
      return user?.settings?.[key] ?? defaultValue ?? null;
    },
    [user],
  );

  const refreshCurrentUser = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    isLoading: isLoading || !isLoaded,
    user: user || null,
    clerkUser: clerkUser || null,
    signOut: signOutClerk,
    isSignedIn,
    isAdmin: user?.isAdmin,
    isImpersonating: !!actor,
    updateUserSetting,
    clearUserSetting,
    getUserSetting,
    refreshCurrentUser,
  };
};
