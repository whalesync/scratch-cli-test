import { Loader } from '@mantine/core';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { AppMantineProvider } from './providers/MantineProvider';
import { PostHogProvider } from './providers/PostHogProvider';

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
    <AppMantineProvider>
      <AuthProvider>
        <AuthGate>
          <HashRouter>
            <PostHogProvider>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/workspace/:id" element={<WorkspacePage />} />
                </Route>
              </Routes>
            </PostHogProvider>
          </HashRouter>
        </AuthGate>
      </AuthProvider>
    </AppMantineProvider>
  );
}

export default App;
