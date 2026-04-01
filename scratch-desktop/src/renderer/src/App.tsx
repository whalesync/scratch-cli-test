import { Center, Loader } from '@mantine/core';
import React, { Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { Layout } from './components/Layout';
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

function App() {
  return (
    <SWRConfig value={{ revalidateOnFocus: false }}>
      <AppMantineProvider>
        <AuthProvider>
          <AuthGate>
            <HashRouter>
              <PostHogProvider>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route element={<Layout />}>
                      <Route path="/" element={<HomePage />} />
                      <Route path="/workspace/:id" element={<WorkspacePage />} />
                      <Route path="/workspace/:id/debug" element={<WorkspacePageDebug />} />
                    </Route>
                  </Routes>
                </Suspense>
              </PostHogProvider>
            </HashRouter>
          </AuthGate>
        </AuthProvider>
      </AppMantineProvider>
    </SWRConfig>
  );
}

export default App;
