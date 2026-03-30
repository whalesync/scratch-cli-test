import { SignIn } from '@clerk/clerk-react';
import { useClerkAppearance } from '../hooks/use-clerk-appearance/useClerkAppearance';

export function SignInPage() {
  const appearance = useClerkAppearance();

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <SignIn routing="hash" appearance={appearance} />
    </div>
  );
}
