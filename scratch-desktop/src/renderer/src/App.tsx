import { Center, Loader } from '@mantine/core';
import React, { Suspense } from 'react';
import { HashRouter, Route, Routes, useParams } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { DeepLinkBridge } from './components/DeepLinkBridge';
import { Layout } from './components/Layout';
import { useCurrentUser } from './hooks/use-current-user';
import { LoginPage } from './pages/LoginPage';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { AppMantineProvider } from './providers/MantineProvider';
import { PostHogProvider } from './providers/PostHogProvider';

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
  const { user } = useCurrentUser();

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
        <AuthProvider>
          <HashRouter>
            <DeepLinkBridge />
            <AuthGate>
              <AppRoutes />
            </AuthGate>
          </HashRouter>
        </AuthProvider>
      </AppMantineProvider>
    </SWRConfig>
  );
}

export default App;
