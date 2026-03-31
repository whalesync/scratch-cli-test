import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { SignInPage } from './pages/SignInPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AuthProvider } from './providers/AuthProvider';
import { AppClerkProvider } from './providers/ClerkProvider';
import { AppMantineProvider } from './providers/MantineProvider';

function App(): JSX.Element {
  return (
    <AppClerkProvider>
      <AppMantineProvider>
        <SignedOut>
          <SignInPage />
        </SignedOut>
        <SignedIn>
          <AuthProvider>
            <HashRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/workspace/:id" element={<WorkspacePage />} />
                </Route>
              </Routes>
            </HashRouter>
          </AuthProvider>
        </SignedIn>
      </AppMantineProvider>
    </AppClerkProvider>
  );
}

export default App;
