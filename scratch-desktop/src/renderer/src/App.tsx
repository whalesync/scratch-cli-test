import { Alert, Center, Loader, Stack } from '@mantine/core';
import { isConnectionError as isServerConnectionError } from '@spinner/shared-types/api-client';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { ButtonPrimaryLight } from './components/base/buttons';
import { DeepLinkBridge } from './components/DeepLinkBridge';
import { Layout } from './components/Layout';
import { ServerConnectionSplash } from './components/ServerConnectionSplash';
import { useCurrentUser } from './hooks/use-current-user';
import { listLocalWorkspaces } from './lib/local-workspaces';
import { scratchApiClient } from './lib/scratch-api-client';
import { LoginPage } from './pages/LoginPage';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { CliInstallProvider } from './providers/CliInstallProvider';
import { AppMantineProvider } from './providers/MantineProvider';
import { PostHogProvider } from './providers/PostHogProvider';
import { UpdaterProvider } from './providers/UpdaterProvider';

const HomePage = React.lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const WelcomePage = React.lazy(() => import('./pages/WelcomePage').then((m) => ({ default: m.WelcomePage })));
const WorkspacePage = React.lazy(() => import('./pages/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const WorkspacePageDebug = React.lazy(() =>
  import('./pages/WorkspacePageDebug').then((m) => ({ default: m.WorkspacePageDebug })),
);
const OAuthCallbackPage = React.lazy(() =>
  import('./pages/OAuthCallbackPage').then((m) => ({ default: m.OAuthCallbackPage })),
);
const PublishHistoryPage = React.lazy(() =>
  import('./pages/PublishHistoryPage').then((m) => ({ default: m.PublishHistoryPage })),
);
const PublishPlanDetailPage = React.lazy(() =>
  import('./pages/PublishPlanDetailPage').then((m) => ({ default: m.PublishPlanDetailPage })),
);
const SettingsLayout = React.lazy(() =>
  import('./pages/settings/SettingsLayout').then((m) => ({ default: m.SettingsLayout })),
);
const ApplicationSettingsPage = React.lazy(() =>
  import('./pages/settings/ApplicationSettingsPage').then((m) => ({ default: m.ApplicationSettingsPage })),
);
const UserSettingsPage = React.lazy(() =>
  import('./pages/settings/UserSettingsPage').then((m) => ({ default: m.UserSettingsPage })),
);
const BillingSettingsPage = React.lazy(() =>
  import('./pages/settings/billing/BillingSettingsPage').then((m) => ({ default: m.BillingSettingsPage })),
);

function PageLoader() {
  return (
    <Center h="100%">
      <Loader size="sm" />
    </Center>
  );
}

/** Remount when :id changes so workspace UI state (grid, selection) cannot leak between workbooks. */
function WorkspacePageRoute() {
  const { id } = useParams<{ id: string }>();
  return <WorkspacePage key={id} />;
}

function WorkspacePageDebugRoute() {
  const { id } = useParams<{ id: string }>();
  return <WorkspacePageDebug key={id} />;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Loader size="lg" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}

/**
 * One-time startup interstitial: checks for a stored workspace (or first available)
 * and navigates there before showing any UI. Only runs on initial app launch —
 * subsequent navigations to "/" show the normal HomePage picker.
 */
function StartupRedirect({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    void (async () => {
      try {
        const storedId = await window.scratchPreferences.getCurrentWorkspaceId();
        console.log('[StartupRedirect] storedId:', storedId, typeof storedId);
        if (storedId) {
          // Validate the stored workspace is accessible and downloaded locally before navigating.
          try {
            const [, localWorkspaces] = await Promise.all([
              scratchApiClient.workspaces.detail(storedId),
              listLocalWorkspaces(),
            ]);
            const isDownloaded = localWorkspaces.some((entry) => entry.id === storedId);
            console.log(
              '[StartupRedirect] stored-ID branch: isDownloaded:',
              isDownloaded,
              'localWorkspaces:',
              localWorkspaces,
            );
            if (isDownloaded) {
              console.log('[StartupRedirect] → navigating to workspace', storedId);
              void navigate(`/workspace/${storedId}`, { replace: true });
              setReady(true);
              return;
            }
          } catch (err) {
            console.log('[StartupRedirect] stored-ID validation error:', err);
          }
          console.log('[StartupRedirect] clearing stored ID, falling through');
          void window.scratchPreferences.setCurrentWorkspaceId(null);
          // Fall through to the no-stored-ID check below (user may still have 0 downloaded workspaces)
        }

        // No stored ID (or just cleared) — show welcome when there are remote workspaces but nothing downloaded yet.
        // Cross-check registry IDs against the remote list (same logic as useWorkspaces) so stale/orphaned
        // registry entries from other accounts don't count as "downloaded".
        const [workspaces, localRegistry] = await Promise.all([
          scratchApiClient.workspaces.list(undefined, 'updatedAt', 'desc'),
          listLocalWorkspaces(),
        ]);
        const remoteIds = new Set<string>(workspaces.map((ws) => ws.id));
        const downloadedCount = localRegistry.filter((entry) => remoteIds.has(entry.id)).length;
        console.log(
          '[StartupRedirect] no-stored-ID branch: remoteWorkspaces:',
          workspaces.length,
          'registryEntries:',
          localRegistry.length,
          'downloadedCount:',
          downloadedCount,
        );
        if (workspaces.length > 0 && downloadedCount === 0) {
          console.log('[StartupRedirect] → navigating to /welcome');
          void navigate('/welcome', { replace: true });
          setReady(true);
          return;
        }
        console.log('[StartupRedirect] → falling through to HomePage');
      } catch (err) {
        console.log('[StartupRedirect] outer catch:', err);
      }
      setReady(true);
    })();
  }, [navigate]);

  if (!ready) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }

  return <>{children}</>;
}

function AppRoutes() {
  const { user, isLoading, error, refreshUser } = useCurrentUser();

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }

  if (error && isServerConnectionError(error)) {
    return <ServerConnectionSplash />;
  }

  if (error) {
    return (
      <Stack p="xl" gap="md" maw={480} mx="auto" mt="xl">
        <Alert color="red" title="Couldn't load your account">
          {error.message}
        </Alert>
        <ButtonPrimaryLight onClick={() => void refreshUser()}>Try again</ButtonPrimaryLight>
      </Stack>
    );
  }

  return (
    <PostHogProvider user={user}>
      <StartupRedirect>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route
              path="/oauth-callback"
              element={
                <Suspense fallback={<PageLoader />}>
                  <OAuthCallbackPage />
                </Suspense>
              }
            />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/settings/billing" replace />} />
              {/* Application is hidden from the nav for now (DEV-10538) but kept routable for easy re-enable. */}
              <Route path="application" element={<ApplicationSettingsPage />} />
              <Route path="user" element={<UserSettingsPage />} />
              <Route path="billing" element={<BillingSettingsPage />} />
            </Route>
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/workspace/:id" element={<WorkspacePageRoute />} />
              <Route path="/workspace/:id/debug" element={<WorkspacePageDebugRoute />} />
              <Route path="/workspace/:id/publish-history" element={<PublishHistoryPage />} />
              <Route path="/workspace/:id/publish-plan/:planId" element={<PublishPlanDetailPage />} />
            </Route>
          </Routes>
        </Suspense>
      </StartupRedirect>
    </PostHogProvider>
  );
}

function App() {
  return (
    <SWRConfig value={{ revalidateOnFocus: false }}>
      <AppMantineProvider>
        <UpdaterProvider>
          <CliInstallProvider>
            <AuthProvider>
              <HashRouter>
                <DeepLinkBridge />
                <AuthGate>
                  <AppRoutes />
                </AuthGate>
              </HashRouter>
            </AuthProvider>
          </CliInstallProvider>
        </UpdaterProvider>
      </AppMantineProvider>
    </SWRConfig>
  );
}

export default App;
