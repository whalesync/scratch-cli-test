import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { mapDeepLinkToDesktopRoute } from '../lib/deep-link-routes';
import { useAuth } from '../providers/AuthProvider';

const PENDING_DEEP_LINK_KEY = 'scratch-pending-deep-link';
const NAV_DEBOUNCE_MS = 400;

/**
 * Listens for scratch:// deep links from the main process and navigates the HashRouter.
 * When the user is not authenticated, stores the target until after login.
 */
export function DeepLinkBridge(): null {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const lastNavAtRef = useRef(0);

  useEffect(() => {
    const api = window.scratchDeepLink;
    if (!api) {
      return;
    }

    const unsubscribe = api.onDeepLink((route, query) => {
      const now = Date.now();
      if (now - lastNavAtRef.current < NAV_DEBOUNCE_MS) {
        return;
      }
      lastNavAtRef.current = now;

      void mapDeepLinkToDesktopRoute(route, query).then((target) => {
        if (isAuthenticated) {
          void navigate(target);
        } else {
          try {
            sessionStorage.setItem(PENDING_DEEP_LINK_KEY, target);
          } catch {
            /* ignore quota / private mode */
          }
        }
      });
    });

    return unsubscribe;
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    if (isLoading || !isAuthenticated) {
      return;
    }
    try {
      const pending = sessionStorage.getItem(PENDING_DEEP_LINK_KEY);
      if (pending) {
        sessionStorage.removeItem(PENDING_DEEP_LINK_KEY);
        void navigate(pending);
      }
    } catch {
      /* ignore */
    }
  }, [isLoading, isAuthenticated, navigate]);

  return null;
}
