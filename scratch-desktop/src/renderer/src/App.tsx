import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { HomePage } from './pages/HomePage';
import { SignInPage } from './pages/SignInPage';
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
            <HomePage />
          </AuthProvider>
        </SignedIn>
      </AppMantineProvider>
    </AppClerkProvider>
  );
}

export default App;
