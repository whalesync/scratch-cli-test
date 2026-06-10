import { isConnectionError } from '@spinner/shared-types/api-client';
import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { logPerf } from '../lib/perf';
import {
  getScratchApiBaseUrl,
  scratchApiClient,
  setScratchApiToken,
  setScratchApiUnauthorizedHandler,
} from '../lib/scratch-api-client';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

interface AuthFlowState {
  active: boolean;
  userCode: string | null;
  verificationUrl: string | null;
  error: string | null;
  /** Set when login cannot reach the Scratch API (network / gateway). */
  connectionUnavailable: boolean;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  email: string | null;
  expiringSoon: boolean;
  login: (opts?: { signUp?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  cancelLogin: () => void;
  authFlow: AuthFlowState;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [expiringSoon, setExpiringSoon] = useState(false);
  const [authFlow, setAuthFlow] = useState<AuthFlowState>({
    active: false,
    userCode: null,
    verificationUrl: null,
    error: null,
    connectionUnavailable: false,
  });
  const pollAbortRef = useRef<AbortController | null>(null);

  // On any 401 from authenticated requests, clear creds and bounce to LoginPage
  useEffect(() => {
    setScratchApiUnauthorizedHandler(() => {
      void (async () => {
        try {
          await window.scratchAuth.clearCredentials();
        } catch (e) {
          console.debug('Failed to clear credentials after 401', e);
        }
        setScratchApiToken(null);
        setIsAuthenticated(false);
        setEmail(null);
        setExpiringSoon(false);
      })();
    });
    return () => setScratchApiUnauthorizedHandler(null);
  }, []);

  // Check for existing credentials on mount
  useEffect(() => {
    void (async () => {
      const authStart = performance.now();
      try {
        const credsStart = performance.now();
        const creds = await window.scratchAuth.getCredentials();
        logPerf('auth getCredentials IPC round-trip', performance.now() - credsStart);

        if (creds.apiToken) {
          const expiryStart = performance.now();
          const expired = await window.scratchAuth.isTokenExpired();
          logPerf('auth isTokenExpired IPC round-trip', performance.now() - expiryStart);

          if (expired) {
            await window.scratchAuth.clearCredentials();
          } else {
            setScratchApiToken(creds.apiToken);
            startTransition(() => {
              setEmail(creds.email);
              setIsAuthenticated(true);

              // Check if expiring soon
              if (creds.tokenExpiresAt) {
                const daysLeft = (new Date(creds.tokenExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
                setExpiringSoon(daysLeft <= TOKEN_EXPIRY_WARNING_DAYS);
              }
            });
          }
        }
      } catch (e) {
        console.debug('Failed to load stored credentials', e);
      } finally {
        logPerf('auth init total', performance.now() - authStart);
        setIsLoading(false);
      }
    })();
  }, []);

  // Check token expiry on window focus
  useEffect(() => {
    const handleFocus = (): void => {
      void (async () => {
        if (!isAuthenticated) return;
        const expired = await window.scratchAuth.isTokenExpired();
        if (expired) {
          await window.scratchAuth.clearCredentials();
          setScratchApiToken(null);
          setIsAuthenticated(false);
          setEmail(null);
        }
      })();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isAuthenticated]);

  const cancelLogin = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setAuthFlow({
      active: false,
      userCode: null,
      verificationUrl: null,
      error: null,
      connectionUnavailable: false,
    });
  }, []);

  const login = useCallback(async (opts?: { signUp?: boolean }) => {
    setAuthFlow({
      active: true,
      userCode: null,
      verificationUrl: null,
      error: null,
      connectionUnavailable: false,
    });

    try {
      const apiUrl = getScratchApiBaseUrl();

      // Initiate auth (unauthenticated device-code path — no Authorization header)
      const initResp = await scratchApiClient.auth.initiateDeviceCode();

      if (initResp.error || !initResp.userCode || !initResp.pollingCode || !initResp.verificationUrl) {
        setAuthFlow((prev) => ({
          ...prev,
          error: initResp.error ?? 'Failed to initiate authentication',
          connectionUnavailable: false,
        }));
        return;
      }

      const userCode = initResp.userCode;
      const pollingCode = initResp.pollingCode;
      const cliAuthorizeUrl = `${initResp.verificationUrl}?code=${userCode}&client=desktop`;
      let verificationUrlWithCode: string;
      if (opts?.signUp) {
        const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
        verificationUrlWithCode = `${webUrl}/sign-up?redirect_url=${encodeURIComponent(cliAuthorizeUrl)}`;
      } else {
        verificationUrlWithCode = cliAuthorizeUrl;
      }
      setAuthFlow((prev) => ({
        ...prev,
        userCode,
        verificationUrl: verificationUrlWithCode,
      }));

      // Open browser
      await window.scratchAuth.openExternal(verificationUrlWithCode);

      // Poll for approval
      const abortController = new AbortController();
      pollAbortRef.current = abortController;

      const pollInterval = (initResp.interval ?? 5) * 1000;
      const deadline = Date.now() + (initResp.expiresIn ?? 600) * 1000;

      while (Date.now() < deadline && !abortController.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        if (abortController.signal.aborted) break;

        try {
          const pollResp = await scratchApiClient.auth.pollDeviceCode({ pollingCode });

          switch (pollResp.status) {
            case 'approved': {
              if (!pollResp.apiToken) {
                setAuthFlow((prev) => ({ ...prev, error: 'No token received', connectionUnavailable: false }));
                return;
              }

              await window.scratchAuth.saveCredentials({
                apiToken: pollResp.apiToken,
                email: pollResp.userEmail,
                tokenExpiresAt: pollResp.tokenExpiresAt,
                serverUrl: apiUrl,
              });

              setScratchApiToken(pollResp.apiToken);
              setEmail(pollResp.userEmail ?? null);
              setIsAuthenticated(true);
              setAuthFlow({
                active: false,
                userCode: null,
                verificationUrl: null,
                error: null,
                connectionUnavailable: false,
              });
              return;
            }
            case 'denied':
              setAuthFlow((prev) => ({
                ...prev,
                active: false,
                error: pollResp.error ?? 'Authorization denied',
                connectionUnavailable: false,
              }));
              return;
            case 'expired':
              setAuthFlow((prev) => ({
                ...prev,
                active: false,
                error: 'Authorization code expired. Please try again.',
                connectionUnavailable: false,
              }));
              return;
            case 'pending':
              break;
          }
        } catch {
          // Polling error — continue
        }
      }

      if (!abortController.signal.aborted) {
        setAuthFlow((prev) => ({
          ...prev,
          active: false,
          error: 'Authorization timed out. Please try again.',
          connectionUnavailable: false,
        }));
      }
    } catch (e) {
      if (isConnectionError(e)) {
        setAuthFlow({
          active: false,
          userCode: null,
          verificationUrl: null,
          error: null,
          connectionUnavailable: true,
        });
        return;
      }
      const message = e instanceof Error ? e.message : 'Failed to start authentication';
      setAuthFlow((prev) => ({ ...prev, active: false, error: message, connectionUnavailable: false }));
    }
  }, []);

  const logout = useCallback(async () => {
    await window.scratchAuth.clearCredentials();
    setScratchApiToken(null);
    setIsAuthenticated(false);
    setEmail(null);
    setExpiringSoon(false);
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, isLoading, email, expiringSoon, login, logout, cancelLogin, authFlow }),
    [isAuthenticated, isLoading, email, expiringSoon, login, logout, cancelLogin, authFlow],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
