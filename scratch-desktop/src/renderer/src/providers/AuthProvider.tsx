import { useAuth, useUser } from '@clerk/clerk-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_CONFIG } from '../lib/api';

const JWT_TOKEN_REFRESH_MS = 10000; // 10 seconds

/**
 * Wires Clerk auth to the API client. Registers a token provider on API_CONFIG
 * so every API request fetches a fresh JWT on-demand, and periodically checks
 * session validity to detect sign-outs.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { getToken, signOut } = useAuth();
  const { isLoaded, isSignedIn } = useUser();
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const hadTokenRef = useRef(false);

  const loadToken = useCallback(async () => {
    const newToken = await getToken();

    if (newToken) {
      hadTokenRef.current = true;
      setTokenLoaded(true);
    } else if (hadTokenRef.current) {
      // Session expired — sign out
      await signOut();
    }
  }, [getToken, signOut]);

  // Register the token provider so every API request fetches a fresh token on-demand
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      API_CONFIG.setTokenProvider(() => getToken());
    }
    return () => {
      API_CONFIG.setTokenProvider(null);
    };
  }, [isLoaded, isSignedIn, getToken]);

  // Check session validity when auth state changes
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      loadToken().catch(console.error);
    }
  }, [isLoaded, isSignedIn, loadToken]);

  // Periodically check session validity
  useEffect(() => {
    const interval = setInterval(() => {
      loadToken().catch(console.error);
    }, JWT_TOKEN_REFRESH_MS);

    return () => clearInterval(interval);
  }, [loadToken]);

  // Refresh the token when the window regains focus
  useEffect(() => {
    const handleFocus = () => {
      if (isLoaded && isSignedIn) {
        loadToken().catch(console.error);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isLoaded, isSignedIn, loadToken]);

  if (!tokenLoaded) {
    return null; // Loading state — will be replaced with a proper loader later
  }

  return <>{children}</>;
}
