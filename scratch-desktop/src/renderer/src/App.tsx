import { Alert, Center, Loader, Stack } from '@mantine/core';
import React, { Suspense } from 'react';
import { HashRouter, Route, Routes, useParams } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { ButtonPrimaryLight } from './components/base/buttons';
import { DeepLinkBridge } from './components/DeepLinkBridge';
import { Layout } from './components/Layout';
import { ServerConnectionSplash } from './components/ServerConnectionSplash';
import { useCurrentUser } from './hooks/use-current-user';
import { isServerConnectionError } from './lib/is-server-connection-error';
import { LoginPage } from './pages/LoginPage';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { AppMantineProvider } from './providers/MantineProvider';
import { PostHogProvider } from './providers/PostHogProvider';
import { UpdaterProvider } from './providers/UpdaterProvider';

const HomePage = React.lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const WorkspacePage = React.lazy(() => import('./pages/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const WorkspacePageDebug = React.lazy(() =>
  import('./pages/WorkspacePageDebug').then((m) => ({ default: m.WorkspacePageDebug })),
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
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/workspace/:id" element={<WorkspacePageRoute />} />
            <Route path="/workspace/:id/debug" element={<WorkspacePageDebugRoute />} />
          </Route>
        </Routes>
      </Suspense>
    </PostHogProvider>
  );
}

function App() {
  return (
    <SWRConfig value={{ revalidateOnFocus: false }}>
      <AppMantineProvider>
        <UpdaterProvider>
          <AuthProvider>
            <HashRouter>
              <DeepLinkBridge />
              <AuthGate>
                <AppRoutes />
              </AuthGate>
            </HashRouter>
          </AuthProvider>
        </UpdaterProvider>
      </AppMantineProvider>
    </SWRConfig>
  );
}

export default App;
