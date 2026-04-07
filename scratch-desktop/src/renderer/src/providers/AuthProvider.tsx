import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { API_CONFIG } from '../lib/api';
import { logPerf } from '../lib/perf';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

interface AuthFlowState {
  active: boolean;
  userCode: string | null;
  verificationUrl: string | null;
  error: string | null;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  email: string | null;
  expiringSoon: boolean;
  login: () => Promise<void>;
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

interface InitiateResponse {
  userCode?: string;
  pollingCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

interface PollResponse {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  apiToken?: string;
  userEmail?: string;
  tokenExpiresAt?: string;
  error?: string;
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
  });
  const pollAbortRef = useRef<AbortController | null>(null);

  // On any 401 from authenticated requests, clear creds and bounce to LoginPage
  useEffect(() => {
    API_CONFIG.setUnauthorizedHandler(() => {
      void (async () => {
        try {
          await window.scratchAuth.clearCredentials();
        } catch (e) {
          console.debug('Failed to clear credentials after 401', e);
        }
        API_CONFIG.setStaticToken(null);
        setIsAuthenticated(false);
        setEmail(null);
        setExpiringSoon(false);
      })();
    });
    return () => API_CONFIG.setUnauthorizedHandler(null);
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
            API_CONFIG.setStaticToken(creds.apiToken);
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
          API_CONFIG.setStaticToken(null);
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
    setAuthFlow({ active: false, userCode: null, verificationUrl: null, error: null });
  }, []);

  const login = useCallback(async () => {
    setAuthFlow({ active: true, userCode: null, verificationUrl: null, error: null });

    try {
      const apiUrl = API_CONFIG.getApiUrl();
      const unauthAxios = API_CONFIG.getUnauthenticatedAxiosInstance();

      // Initiate auth
      const { data: initResp } = await unauthAxios.post<InitiateResponse>('/cli/v1/auth/initiate');

      if (initResp.error || !initResp.userCode || !initResp.pollingCode || !initResp.verificationUrl) {
        setAuthFlow((prev) => ({ ...prev, error: initResp.error ?? 'Failed to initiate authentication' }));
        return;
      }

      const verificationUrlWithCode = `${initResp.verificationUrl}?code=${initResp.userCode}&client=desktop`;
      setAuthFlow((prev) => ({
        ...prev,
        userCode: initResp.userCode!,
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
          const { data: pollResp } = await unauthAxios.post<PollResponse>('/cli/v1/auth/poll', {
            pollingCode: initResp.pollingCode,
          });

          switch (pollResp.status) {
            case 'approved': {
              if (!pollResp.apiToken) {
                setAuthFlow((prev) => ({ ...prev, error: 'No token received' }));
                return;
              }

              await window.scratchAuth.saveCredentials({
                apiToken: pollResp.apiToken,
                email: pollResp.userEmail,
                tokenExpiresAt: pollResp.tokenExpiresAt,
                serverUrl: apiUrl,
              });

              API_CONFIG.setStaticToken(pollResp.apiToken);
              setEmail(pollResp.userEmail ?? null);
              setIsAuthenticated(true);
              setAuthFlow({ active: false, userCode: null, verificationUrl: null, error: null });
              return;
            }
            case 'denied':
              setAuthFlow((prev) => ({ ...prev, active: false, error: pollResp.error ?? 'Authorization denied' }));
              return;
            case 'expired':
              setAuthFlow((prev) => ({
                ...prev,
                active: false,
                error: 'Authorization code expired. Please try again.',
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
        setAuthFlow((prev) => ({ ...prev, active: false, error: 'Authorization timed out. Please try again.' }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to start authentication';
      setAuthFlow((prev) => ({ ...prev, active: false, error: message }));
    }
  }, []);

  const logout = useCallback(async () => {
    await window.scratchAuth.clearCredentials();
    API_CONFIG.setStaticToken(null);
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
