import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { ScratchPlanType, User, UserDetails } from '@spinner/shared-types';
import { useState } from 'react';
import { useScratchPadUser } from './useScratchpadUser';

/**
 * @returns A hook with dev tools for user management
 */
export const useUserDevTools = () => {
  const { refreshCurrentUser } = useScratchPadUser();
  const [results, setResults] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [currentUserDetails, setCurrentUserDetails] = useState<UserDetails | undefined>(undefined);

  const search = async (query: string) => {
    if (!query.trim()) {
      setError(new Error('Query is empty'));
      return;
    }
    try {
      setResults([]);
      setCurrentUserDetails(undefined);
      setIsLoading(true);
      const response = await scratchApiClient.devTools.searchUsers(query);
      setResults(response);
    } catch (error) {
      setError(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const retrieveUserDetails = async (userId: string) => {
    try {
      setIsLoading(true);
      const response = await scratchApiClient.devTools.getUserDetails(userId);
      setCurrentUserDetails(response);
    } catch (error) {
      setError(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateActiveUserSubscription = async (newPlan: ScratchPlanType) => {
    try {
      setIsLoading(true);
      await scratchApiClient.devTools.updateUserSubscription(newPlan);
      await refreshCurrentUser();
      ScratchpadNotifications.success({ message: `Your subscription was successfully updated to ${newPlan}` });
    } catch (error) {
      setError(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const forceExpireActiveUserSubscription = async () => {
    try {
      setIsLoading(true);
      await scratchApiClient.devTools.forceExpireSubscription();
      await refreshCurrentUser();
      ScratchpadNotifications.success({ message: `Your subscription was successfully expired` });
    } catch (error) {
      setError(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const forceCancelActiveUserSubscription = async () => {
    try {
      setIsLoading(true);
      await scratchApiClient.devTools.forceCancelSubscription();
      await refreshCurrentUser();
      ScratchpadNotifications.success({ message: `Your subscription was marked for cancellation` });
    } catch (error) {
      setError(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    users: results,
    isLoading,
    error,
    search,
    retrieveUserDetails,
    currentUserDetails,
    clearCurrentUserDetails: () => setCurrentUserDetails(undefined),
    updateActiveUserSubscription,
    forceExpireActiveUserSubscription,
    forceCancelActiveUserSubscription,
  };
};
