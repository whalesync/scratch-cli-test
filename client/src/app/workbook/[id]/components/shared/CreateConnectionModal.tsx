import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import {
  getOauthLabel,
  getOauthPrivateLabel,
  getServiceName,
  useConnectorsMetadata,
} from '@/hooks/use-connectors-metadata';
import { useSubscription } from '@/hooks/use-subscription';
import { ScratchpadApiError } from '@/lib/api/error';
import { initiateOAuth } from '@/utils/oauth';
import {
  Alert,
  Checkbox,
  Group,
  Text as MantineText,
  ModalProps,
  PasswordInput,
  Radio,
  SimpleGrid,
  Stack,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { Service } from '@spinner/shared-types';
import { Check } from 'lucide-react';
import { useState } from 'react';

import { AuthMethod, useConnectors } from '@/hooks/use-connectors';
import type { ConnectorAccount } from '@spinner/shared-types';

export type CreateConnectionModalProps = ModalProps & {
  workbookId: string;
  returnUrl?: string;
  onConnectionCreated?: (account: ConnectorAccount) => void;
};

export const CreateConnectionModal = (props: CreateConnectionModalProps) => {
  const { workbookId, returnUrl, onConnectionCreated, ...modalProps } = props;
  const [error, setError] = useState<string | null>(null);
  const [newDisplayName, setNewDisplayName] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [newService, setNewService] = useState<Service | null>(null);
  const [newModifier, setNewModifier] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('oauth');

  const [shopDomain, setShopDomain] = useState('');
  const [quickbooksSandbox, setQuickbooksSandbox] = useState(false);
  const [isOAuthLoading, setIsOAuthLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [showOAuthCustom, setShowOAuthCustom] = useState(false);
  const { metadata } = useConnectorsMetadata();
  const { canCreateDataSource } = useSubscription();
  const { createConnectorAccount } = useConnectorAccounts(workbookId);
  const { getDefaultAuthMethod, getSupportedAuthMethods, availableServices } = useConnectors();

  const handleSelectNewService = (service: Service) => {
    setNewService(service);
    setNewDisplayName(getServiceName(metadata, service));
    setAuthMethod(getDefaultAuthMethod(service));
    setCustomClientId('');
    setCustomClientSecret('');
  };

  const handleClearForm = () => {
    setNewApiKey('');
    setUsername('');
    setPassword('');
    setEndpoint('');
    setDomain('');
    setConnectionString('');
    setShopDomain('');
    setQuickbooksSandbox(false);
    setNewService(null);
    setNewModifier(null);
    setNewDisplayName(null);
    setAuthMethod('oauth'); // Reset to default
    setError(null);
  };

  const handleOAuthInitiate = async () => {
    if (!newService) {
      setError('Please select a service first.');
      return;
    }

    setIsOAuthLoading(true);
    try {
      const isCustom = authMethod === 'oauth_custom';
      const connectionName = newDisplayName ?? undefined;
      const returnPage = returnUrl ?? window.location.pathname;
      console.debug('connectionName', connectionName);
      await initiateOAuth(newService, {
        // (http|https)://<host, e.g. test.scratch.md>
        redirectPrefix: `${window.location.protocol}//${window.location.host}`,
        workbookId: workbookId,
        connectionMethod: isCustom ? 'OAUTH_CUSTOM' : 'OAUTH_SYSTEM',
        customClientId: isCustom ? customClientId : undefined,
        customClientSecret: isCustom ? customClientSecret : undefined,
        connectionName: connectionName,
        returnPage: returnPage,
        shopDomain: newService === Service.SHOPIFY ? shopDomain : undefined,
        quickbooksSandbox: newService === Service.QUICKBOOKS ? quickbooksSandbox : undefined,
      });
      // The initiateOAuth function will redirect the user, so we don't need to do anything else here
    } catch (error) {
      console.error('OAuth initiation failed:', error);
      setError('Failed to start OAuth flow. Please try again.');
      setIsOAuthLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newService) {
      setError('Service is required.');
      return;
    }
    if (!canCreateDataSource(newService)) {
      setError(
        `You have reached the limit for ${getServiceName(metadata, newService)} connections. Please upgrade your plan to add more.`,
      );
      return;
    }
    if (
      authMethod === 'user_provided_params' &&
      newService !== Service.WORDPRESS &&
      newService !== Service.MOCO &&
      newService !== Service.POSTGRES &&
      newService !== Service.SHOPIFY &&
      newService !== Service.SUPABASE &&
      !newApiKey
    ) {
      setError('API key is required for this service.');
      return;
    }
    if (
      authMethod === 'user_provided_params' &&
      (newService === Service.POSTGRES || newService === Service.SUPABASE) &&
      !connectionString
    ) {
      setError('Connection string is required.');
      return;
    }
    if (
      authMethod === 'user_provided_params' &&
      newService === Service.WORDPRESS &&
      !username &&
      !password &&
      !endpoint
    ) {
      setError('Username, password, and endpoint are required for this service.');
      return;
    }
    if (authMethod === 'user_provided_params' && newService === Service.MOCO && (!domain || !newApiKey)) {
      setError('Domain and API key are required for Moco.');
      return;
    }
    if (authMethod === 'user_provided_params' && newService === Service.SHOPIFY && (!shopDomain || !newApiKey)) {
      setError('Shop domain and API access token are required for Shopify.');
      return;
    }
    try {
      setIsCreating(true);
      // For OAuth, the connection will be created in the callback page
      if (authMethod === 'oauth' || authMethod === 'oauth_custom') {
        await handleOAuthInitiate();
        return;
      }

      const createdAccount = await createConnectorAccount({
        service: newService,
        userProvidedParams:
          newService === Service.WORDPRESS
            ? { username, password, endpoint }
            : newService === Service.MOCO
              ? { domain, apiKey: newApiKey }
              : newService === Service.SHOPIFY
                ? { shopDomain, apiKey: newApiKey }
                : newService === Service.POSTGRES || newService === Service.SUPABASE
                  ? { connectionString }
                  : { apiKey: newApiKey },
        modifier: newModifier || undefined,
        displayName: newDisplayName || undefined,
      });

      if (createdAccount.healthStatus === 'FAILED') {
        setError(createdAccount.healthStatusMessage || 'Connection test failed. Please check your credentials.');
        return;
      }

      handleClearForm();
      props.onClose?.();
      onConnectionCreated?.(createdAccount);
    } catch (error) {
      console.error('Failed to create connection:', error);
      if (error instanceof ScratchpadApiError) {
        setError(error.message);
      } else {
        setError('Failed to create connection. Please try again.');
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ModalWrapper
      title="Create Connection"
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline onClick={props.onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleCreate} loading={isOAuthLoading || isCreating}>
              {authMethod === 'oauth' && newService ? 'Connect with ' + getServiceName(metadata, newService) : 'Create'}
            </ButtonPrimaryLight>
          </>
        ),
      }}
      {...modalProps}
      onExitTransitionEnd={() => {
        // clear the form when the modal is closed
        handleClearForm();
      }}
    >
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <MantineText size="sm" fw={500} mb={4}>
          App
        </MantineText>
        <SimpleGrid cols={2} spacing="xs" mb="md">
          {availableServices.map((service) => {
            const isSelected = newService === service;
            return (
              <UnstyledButton
                key={service}
                onClick={() => handleSelectNewService(service)}
                style={{
                  border: `0.5px solid ${isSelected ? 'var(--mantine-color-teal-4)' : 'var(--mantine-color-gray-3)'}`,
                  padding: '6px 8px',
                  backgroundColor: isSelected ? 'var(--mantine-color-teal-0)' : 'transparent',
                  transition: 'all 0.2s ease',
                }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap">
                    <ConnectorIcon connector={service} size={20} />
                    <MantineText size="sm" fw={500}>
                      {getServiceName(metadata, service)}
                    </MantineText>
                  </Group>
                  {isSelected && <Check style={{ width: 12, height: 12, color: 'var(--mantine-color-teal-6)' }} />}
                </Group>
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
        <TextInput
          label="Name"
          placeholder="Enter a name for your connection"
          value={newDisplayName ?? ''}
          required
          onChange={(e) => setNewDisplayName(e.currentTarget.value)}
        />

        {/* Authentication Method */}
        <Stack
          style={{
            minHeight: 150, // So that the UI doesn't jump too much
          }}
        >
          {newService && getSupportedAuthMethods(newService).length > 1 && (
            <Radio.Group
              label={
                <span
                  onClick={(e: React.MouseEvent) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      setShowOAuthCustom(!showOAuthCustom);
                    }
                  }}
                >
                  Authentication Method
                </span>
              }
              value={authMethod}
              onChange={(value) => setAuthMethod(value as AuthMethod)}
            >
              <Group gap="xs" mt="xs">
                {getSupportedAuthMethods(newService).includes('oauth') && (
                  <Radio value="oauth" label={getOauthLabel(metadata, newService)} />
                )}
                {getSupportedAuthMethods(newService).includes('user_provided_params') && (
                  <Radio
                    value="user_provided_params"
                    label={
                      newService === Service.SUPABASE || newService === Service.POSTGRES
                        ? 'Connection String'
                        : 'API Key'
                    }
                  />
                )}
                {newService === Service.YOUTUBE && showOAuthCustom && (
                  <Radio value="oauth_custom" label={getOauthPrivateLabel(metadata, newService)} />
                )}
              </Group>
            </Radio.Group>
          )}
          {/* Private OAuth credentials (YouTube only for now) */}
          {authMethod === 'oauth_custom' && (
            <>
              <Alert color="blue" title="Private OAuth">
                How to set up a private OAuth connection{' '}
                <a href="https://www.google.com" target="_blank" rel="noreferrer">
                  here
                </a>
                .
              </Alert>
              <TextInput
                label="OAuth Client ID"
                placeholder="Enter your app's client ID"
                value={customClientId}
                onChange={(e) => setCustomClientId(e.currentTarget.value)}
              />
              <PasswordInput
                label="OAuth Client Secret"
                placeholder="Enter your app's client secret"
                value={customClientSecret}
                onChange={(e) => setCustomClientSecret(e.currentTarget.value)}
              />
            </>
          )}
          {authMethod === 'oauth' && newService === Service.SHOPIFY && (
            <TextInput
              label="Shop Domain"
              placeholder="your-store.myshopify.com"
              description="Enter your Shopify store domain"
              value={shopDomain}
              onChange={(e) => setShopDomain(e.currentTarget.value)}
            />
          )}
          {authMethod === 'oauth' && newService === Service.QUICKBOOKS && (
            <Checkbox
              label="Sandbox mode"
              description="Connect to the QuickBooks sandbox environment for testing"
              checked={quickbooksSandbox}
              onChange={(e) => setQuickbooksSandbox(e.currentTarget.checked)}
            />
          )}
          {authMethod === 'user_provided_params' && newService === Service.SHOPIFY && (
            <Stack>
              <TextInput
                label="Shop Domain"
                placeholder="your-store.myshopify.com"
                description="Your Shopify store domain (e.g., your-store.myshopify.com)"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.currentTarget.value)}
              />
              <PasswordInput
                label="Admin API Access Token"
                placeholder="shpat_..."
                description="Create a custom app in Settings > Apps > Develop apps to get an access token"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.currentTarget.value)}
              />
            </Stack>
          )}
          {authMethod === 'user_provided_params' && newService === Service.WORDPRESS && (
            <Stack>
              <Group grow>
                <TextInput
                  label="Username"
                  placeholder="Enter your WordPress username"
                  value={username}
                  onChange={(e) => setUsername(e.currentTarget.value)}
                />
                <PasswordInput
                  label="Application password"
                  placeholder="Enter your application password here"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </Group>
              <TextInput
                label="WordPress URL"
                placeholder="Enter the address of your WordPress site here"
                value={endpoint}
                onChange={(e) => setEndpoint(e.currentTarget.value)}
              />
            </Stack>
          )}
          {authMethod === 'user_provided_params' && newService === Service.MOCO && (
            <Stack>
              <TextInput
                label="Moco Domain"
                placeholder="yourcompany"
                description="Your Moco subdomain (e.g., 'yourcompany' from yourcompany.mocoapp.com)"
                value={domain}
                onChange={(e) => setDomain(e.currentTarget.value)}
              />
              <PasswordInput
                label="API Key"
                placeholder="Enter your Moco API key"
                description="Generate an API key in your Moco account under Integrations"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.currentTarget.value)}
              />
            </Stack>
          )}
          {authMethod === 'user_provided_params' && newService === Service.POSTGRES && (
            <PasswordInput
              label="Connection String"
              placeholder="postgres://user:password@host:5432/database"
              value={connectionString}
              onChange={(e) => setConnectionString(e.currentTarget.value)}
            />
          )}
          {authMethod === 'user_provided_params' && newService === Service.SUPABASE && (
            <PasswordInput
              label="Connection String"
              placeholder="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"
              description="Find this in your Supabase project under Settings > Database > Connection string"
              value={connectionString}
              onChange={(e) => setConnectionString(e.currentTarget.value)}
            />
          )}
          {newService &&
            newService !== Service.WORDPRESS &&
            newService !== Service.MOCO &&
            newService !== Service.SHOPIFY &&
            newService !== Service.POSTGRES &&
            newService !== Service.SUPABASE &&
            getSupportedAuthMethods(newService).includes('user_provided_params') &&
            authMethod === 'user_provided_params' && (
              <PasswordInput
                label="API Key"
                placeholder="Enter API Key"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.currentTarget.value)}
              />
            )}
        </Stack>
      </Stack>
    </ModalWrapper>
  );
};
