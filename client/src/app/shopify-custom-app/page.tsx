'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Book, Text13Medium, Text16Regular, TextTitle2, TextTitle3 } from '@/app/components/base/text';
import { Anchor, Box, CopyButton, Divider, Group, Stack, TextInput } from '@mantine/core';
import { Check, ClipboardCopy, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import React, { Suspense, useState } from 'react';

const SCOPES = [
  'read_content',
  'read_files',
  'read_inventory',
  'read_metaobject_definitions',
  'read_metaobjects',
  'read_online_store_pages',
  'read_orders',
  'read_products',
  'read_publications',
  'write_content',
  'write_files',
  'write_inventory',
  'write_metaobject_definitions',
  'write_metaobjects',
  'write_online_store_pages',
  'write_products',
  'write_publications',
].join(',');

function ShopifyAuthContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get('code');
  const shop = searchParams.get('shop');
  const state = searchParams.get('state');

  if (code && shop) {
    return <TokenExchange code={code} shop={shop} clientIdFromState={state} />;
  }

  return <SetupFlow />;
}

function SetupFlow() {
  const [storeDomain, setStoreDomain] = useState('');
  const [clientId, setClientId] = useState('');

  const redirectUri = typeof window !== 'undefined' ? `${window.location.origin}/shopify-custom-app` : '';

  const storeSlug = storeDomain.trim();
  const fullDomain = storeSlug ? `${storeSlug}.myshopify.com` : '';
  const isValidClientId = /^[0-9a-f]{32}$/i.test(clientId.trim());
  const devDashboardUrl = 'https://dev.shopify.com/dashboard/';

  const handleAuthorize = () => {
    const url = new URL(`https://${fullDomain}/admin/oauth/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', clientId);
    window.location.href = url.toString();
  };

  return (
    <Stack gap="xl">
      <Box>
        <TextTitle2>Connect Your Shopify Store</TextTitle2>
        <Text16Regular c="var(--fg-muted)" mt="xs">
          Follow the steps below to create a Shopify custom app and generate an API access token.
        </Text16Regular>
      </Box>

      <InputHighlightBox>
        <TextTitle3>Your Store</TextTitle3>
        <Group gap="xs" align="end" mt="sm">
          <TextInput
            label="Shopify store name"
            placeholder="my-store"
            value={storeDomain}
            onChange={(e) => setStoreDomain(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Text13Medium style={{ paddingBottom: 7 }}>.myshopify.com</Text13Medium>
        </Group>
      </InputHighlightBox>

      {storeSlug && (
        <>
          <Divider />

          <Box>
            <TextTitle3>Step 1: Create a Shopify Custom App</TextTitle3>
            <Stack gap="sm" mt="sm">
              <Text13Book>
                1. Open the{' '}
                <Anchor href={devDashboardUrl} target="_blank">
                  Shopify Developer Dashboard
                </Anchor>
              </Text13Book>
              <Text13Book>
                2. Click <strong>Create app</strong>, give it any name (e.g. &quot;Scratch Integration&quot;), then
                click <strong>Create</strong>
              </Text13Book>
              <Text13Book>3. Fill in the following settings:</Text13Book>

              <Stack gap="xs" pl="md">
                <Box>
                  <Text13Medium>App URL</Text13Medium>
                  <CopyableValue value="https://scratch.md" />
                </Box>
                <Box>
                  <Text13Medium>Access → Scopes</Text13Medium>
                  <CopyableValue value={SCOPES} compact />
                </Box>
                <Box>
                  <Text13Medium>Redirect URL</Text13Medium>
                  <CopyableValue value={redirectUri} />
                </Box>
              </Stack>

              <Text13Book>
                4. Click <strong>Release</strong>
              </Text13Book>

              <InputHighlightBox mt="md">
                <Text13Book>
                  Once your app is created, enter the <strong>Client ID</strong> from <strong>Settings</strong> to
                  continue.
                </Text13Book>
                <TextInput
                  mt="sm"
                  label="Client ID"
                  placeholder="Paste your Client ID here"
                  value={clientId}
                  onChange={(e) => setClientId(e.currentTarget.value)}
                  rightSection={
                    clientId.trim() ? (
                      isValidClientId ? (
                        <Check size={16} color="var(--mantine-color-green-6)" />
                      ) : (
                        <X size={16} color="var(--mantine-color-red-6)" />
                      )
                    ) : null
                  }
                />
              </InputHighlightBox>
            </Stack>
          </Box>
        </>
      )}

      {storeSlug && isValidClientId && (
        <>
          <Divider />

          <Box>
            <TextTitle3>Step 2: Install App</TextTitle3>
            <Stack gap="sm" mt="sm">
              <Text13Book>
                Click the button below to authorize the app with <strong>{fullDomain}</strong>.
              </Text13Book>
              <Box>
                <ButtonPrimarySolid onClick={handleAuthorize}>Authorize with Shopify →</ButtonPrimarySolid>
              </Box>
            </Stack>
          </Box>
        </>
      )}
    </Stack>
  );
}

function TokenExchange({
  code,
  shop,
  clientIdFromState,
}: {
  code: string;
  shop: string;
  clientIdFromState: string | null;
}) {
  const [clientId, setClientId] = useState(clientIdFromState ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleGenerateToken = async () => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/shopify-custom-app/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shop, client_id: clientId, client_secret: clientSecret }),
      });

      const data = (await response.json()) as { access_token?: string; error?: string; errors?: string };

      if (!response.ok) {
        setError(data.error ?? data.errors ?? JSON.stringify(data));
        return;
      }

      setAccessToken(data.access_token ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack gap="xl">
      <Box>
        <TextTitle2>Connect Your Shopify Store</TextTitle2>
        <Text16Regular c="var(--fg-muted)" mt="xs">
          Almost there! Shopify has authorized the app. Now enter your Client Secret to generate your access token.
        </Text16Regular>
      </Box>

      {!accessToken ? (
        <InputHighlightBox>
          <TextTitle3>Step 3: Generate Token</TextTitle3>
          <Stack gap="sm" mt="sm">
            <TextInput label="Client ID" value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
            <TextInput
              label="Client Secret"
              placeholder="Paste your Client Secret here"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.currentTarget.value)}
            />
            {error && (
              <Text13Book c="var(--mantine-color-red-6)">
                <strong>Error:</strong> {typeof error === 'string' ? error : JSON.stringify(error)}
              </Text13Book>
            )}
            <Box>
              <ButtonPrimarySolid onClick={handleGenerateToken} disabled={!clientId || !clientSecret} loading={loading}>
                Generate Token
              </ButtonPrimarySolid>
            </Box>
          </Stack>
        </InputHighlightBox>
      ) : (
        <Box>
          <TextTitle3>Step 4: Copy Your Token</TextTitle3>
          <Stack gap="sm" mt="sm">
            <Box>
              <Text13Medium mb={4}>Access Token</Text13Medium>
              <CopyableValue value={accessToken} />
            </Box>
            <Text13Book>
              Copy this token and paste it into the app where it asks for your Shopify API token. Keep it safe — treat
              it like a password.
            </Text13Book>
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function InputHighlightBox({ children, mt }: { children: React.ReactNode; mt?: string }) {
  return (
    <Box
      mt={mt}
      style={{
        padding: 'var(--mantine-spacing-md)',
        borderRadius: 'var(--mantine-radius-sm)',
        backgroundColor: 'var(--mantine-color-green-2)',
        border: '1px solid var(--mantine-color-green-8)',
      }}
    >
      {children}
    </Box>
  );
}

function CopyableValue({ value, compact }: { value: string; compact?: boolean }) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <TextInput
          value={value || '...'}
          readOnly
          onClick={copy}
          mt={4}
          rightSection={copied ? <Check size={14} color="var(--mantine-color-green-6)" /> : <ClipboardCopy size={14} />}
          styles={{
            input: {
              fontFamily: 'var(--mantine-font-family-monospace)',
              fontSize: '12px',
              cursor: 'pointer',
              ...(compact ? { overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
            },
            section: { cursor: 'pointer' },
          }}
        />
      )}
    </CopyButton>
  );
}

export default function ShopifyAuthPage() {
  return (
    <Box
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bg-base)',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <Box style={{ width: '100%', maxWidth: 640, padding: 'var(--mantine-spacing-xl)' }}>
        <Suspense>
          <ShopifyAuthContent />
        </Suspense>
      </Box>
    </Box>
  );
}
