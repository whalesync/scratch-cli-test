'use client';

import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { usePendingOAuthInstall } from '@/hooks/use-oauth-install';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { RouteUrls } from '@/utils/route-urls';
import { Alert, Container, Loader, Stack } from '@mantine/core';
import { CircleXIcon, PlugZapIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

/**
 * Generic claim page for a marketplace-initiated ("inbound") OAuth install.
 *
 * A connector's marketplace (e.g. the GoHighLevel App Marketplace) redirects the user's browser to the
 * public web page `/oauth/install/:service` (on the web host, not the API host). That page posts the
 * one-time code to the server's redeem endpoint (`POST /oauth/install/:service`), which redeems it,
 * stashes the tokens under an `installId`, and returns it — then forwards here as
 * `/connect/:service?install=<installId>`.
 *
 * This route is NOT in `RouteUrls.publicRoutePatterns`, so Clerk's middleware gates it: an
 * unauthenticated visitor is bounced through sign-up / sign-in first (the `?install=` param survives
 * the round-trip via Clerk's returnBackUrl), then lands back here signed in to finish the claim.
 *
 * Connector-agnostic: nothing here branches on the service. The human-readable service name and any
 * sub-account label are supplied by the server in the install metadata.
 */
function ConnectContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const installId = searchParams.get('install');
  // The redeem endpoint forwards a failure as `?error=` instead of `?install=`.
  const redeemError = searchParams.get('error');

  const { pendingInstall, isLoading, error } = usePendingOAuthInstall(redeemError ? null : installId);

  const [isClaiming, setIsClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | undefined>(undefined);

  const handleConnect = async () => {
    if (!installId) return;
    setIsClaiming(true);
    setClaimError(undefined);
    try {
      const { workbookId } = await scratchApiClient.oauth.claimPendingInstall(installId);
      // Land in the freshly-created workbook. `replace` so Back doesn't return to a now-consumed link.
      router.replace(RouteUrls.workbookPageUrl(workbookId));
    } catch (e) {
      setIsClaiming(false);
      setClaimError(e instanceof Error ? e.message : 'Failed to finish connecting your account.');
    }
  };

  // The marketplace redirect itself failed (bad/expired code, unsupported service).
  if (redeemError) {
    return (
      <ConnectError
        title="We couldn't start the connection"
        message={`${redeemError}. Please retry the install from the marketplace.`}
      />
    );
  }

  if (!installId) {
    return <ConnectError title="Invalid connection link" message="This link is missing its install reference." />;
  }

  if (isLoading) {
    return <ConnectLoading message="Loading your connection…" />;
  }

  if (error || !pendingInstall) {
    return (
      <ConnectError
        title="This connection link is invalid or has expired"
        message="Install links are single-use and expire after a short time. Please retry the install from the marketplace."
      />
    );
  }

  if (isClaiming) {
    return <ConnectLoading message={`Connecting your ${pendingInstall.serviceDisplayName} account…`} />;
  }

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <StyledLucideIcon Icon={PlugZapIcon} size={40} />
        <TextTitle2 ta="center">Connect {pendingInstall.serviceDisplayName} to Scratch</TextTitle2>
        <Text13Regular c="dimmed" ta="center">
          We&apos;ll create a new workspace and connect your {pendingInstall.serviceDisplayName} account to it.
          {pendingInstall.workspaceId ? ` (Sub-account ${pendingInstall.workspaceId})` : ''}
        </Text13Regular>
        {claimError ? (
          <Alert color="red" w="100%" icon={<StyledLucideIcon Icon={CircleXIcon} />}>
            {claimError}
          </Alert>
        ) : null}
        <ButtonPrimarySolid onClick={handleConnect}>Connect {pendingInstall.serviceDisplayName}</ButtonPrimarySolid>
      </Stack>
    </Container>
  );
}

function ConnectLoading({ message }: { message: string }) {
  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <Loader size="lg" />
        <TextTitle2 ta="center">{message}</TextTitle2>
      </Stack>
    </Container>
  );
}

function ConnectError({ title, message }: { title: string; message: string }) {
  const router = useRouter();
  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <StyledLucideIcon Icon={CircleXIcon} size={40} />
        <TextTitle2 ta="center">{title}</TextTitle2>
        <Text13Regular c="dimmed" ta="center">
          {message}
        </Text13Regular>
        <ButtonSecondaryOutline onClick={() => router.replace(RouteUrls.workbookPickerPageUrl)}>
          Go to Scratch
        </ButtonSecondaryOutline>
      </Stack>
    </Container>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<ConnectLoading message="Loading your connection…" />}>
      <ConnectContent />
    </Suspense>
  );
}
