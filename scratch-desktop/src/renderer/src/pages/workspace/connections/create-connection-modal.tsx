import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { ConnectorIcon } from '@/components/icons/ConnectorIcon';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { type AuthMethod, useConnectors } from '@/hooks/use-connectors';
import {
  getOauthLabel,
  getOauthPrivateLabel,
  getServiceName,
  useConnectorsMetadata,
} from '@/hooks/use-connectors-metadata';
import { initiateDesktopOAuth } from '@/lib/oauth-helpers';
import {
  Alert,
  Anchor,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ConnectorAccount, ConnectorSettingDefinition, OAuthInitiateOptionsDto } from '@spinner/shared-types';
import { ConnectorHealthStatus } from '@spinner/shared-types';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useCurrentUser } from '../../../hooks/use-current-user';
import { GenericApiConnectionModal } from './generic-api-connection-modal';

interface CreateConnectionModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  onConnectionCreated?: (account: ConnectorAccount) => void;
}

const MAX_DISPLAY_NAME_SUFFIX = 99;

function suggestUniqueDisplayName(baseName: string, existing: ConnectorAccount[] | undefined): string {
  const existingNames = new Set((existing ?? []).map((a) => a.displayName));
  if (!existingNames.has(baseName)) return baseName;
  for (let i = 1; i <= MAX_DISPLAY_NAME_SUFFIX; i++) {
    const candidate = `${baseName} ${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return baseName;
}

export function CreateConnectionModal({
  opened,
  onClose,
  workbookId,
  onConnectionCreated,
}: CreateConnectionModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [newDisplayName, setNewDisplayName] = useState<string | null>(null);
  const [newService, setNewService] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('oauth');

  const { user } = useCurrentUser();
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [isOAuthLoading, setIsOAuthLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [showOAuthCustom, setShowOAuthCustom] = useState(false);
  const { data: metadata } = useConnectorsMetadata();
  const { connectorAccounts, createConnectorAccount } = useConnectorAccounts(workbookId);
  const { getDefaultAuthMethod, getSupportedAuthMethods, availableServices } = useConnectors();

  const currentFields: ConnectorSettingDefinition[] =
    (newService ? metadata?.[newService]?.credentialFields?.[authMethod] : undefined) ?? [];

  const trimmedDisplayName = (newDisplayName ?? '').trim();
  const isDisplayNameTaken =
    trimmedDisplayName.length > 0 && (connectorAccounts ?? []).some((a) => a.displayName === trimmedDisplayName);

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSelectNewService = (service: string) => {
    setNewService(service);
    setNewDisplayName(suggestUniqueDisplayName(getServiceName(metadata, service), connectorAccounts));
    setAuthMethod(getDefaultAuthMethod(service));
    setCustomClientId('');
    setCustomClientSecret('');
    setFieldValues({});
  };

  const handleClearForm = () => {
    setFieldValues({});
    setNewService(null);
    setNewDisplayName(null);
    setAuthMethod('oauth');
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
      const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';

      const oauthOptions: OAuthInitiateOptionsDto = {
        redirectPrefix: webUrl,
        workbookId,
        connectionMethod: isCustom ? 'OAUTH_CUSTOM' : 'OAUTH_SYSTEM',
        customClientId: isCustom ? customClientId : undefined,
        customClientSecret: isCustom ? customClientSecret : undefined,
        connectionName,
        returnPage: 'scratch://oauth-callback',
      };
      // Assign credential field values to the options
      for (const field of currentFields) {
        const val = fieldValues[field.key];
        if (val !== undefined && val !== '') {
          (oauthOptions as Record<string, unknown>)[field.key] = val;
        }
      }
      await initiateDesktopOAuth(newService, oauthOptions);
    } catch (err) {
      console.debug('OAuth initiation failed:', err);
      setError('Failed to start OAuth flow. Please try again.');
      setIsOAuthLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newService) {
      setError('Service is required.');
      return;
    }

    // Check subscription status
    if (!user?.subscription || user.subscription.status !== 'valid') {
      setError('Your subscription does not allow creating new connections. Please upgrade your plan.');
      return;
    }

    // Validate required credential fields
    if (authMethod === 'user_provided_params') {
      for (const field of currentFields) {
        if (field.required && !fieldValues[field.key]) {
          setError(`${field.label} is required.`);
          return;
        }
      }
    }

    try {
      setIsCreating(true);
      if (authMethod === 'oauth' || authMethod === 'oauth_custom') {
        await handleOAuthInitiate();
        return;
      }

      // Build userProvidedParams from field values
      const userProvidedParams: Record<string, string> = {};
      for (const field of currentFields) {
        const val = fieldValues[field.key];
        if (typeof val === 'string' && val) {
          userProvidedParams[field.key] = val;
        }
      }

      const createdAccount = await createConnectorAccount({
        service: newService,
        userProvidedParams,
        displayName: newDisplayName || undefined,
      });

      if (createdAccount.healthStatus === ConnectorHealthStatus.FAILED) {
        notifications.show({
          title: 'Connection Created with Errors',
          message: createdAccount.healthStatusMessage || 'The connection was created but failed a health check.',
          color: 'red',
          autoClose: 8000,
        });
      }

      handleClearForm();
      onClose();
      onConnectionCreated?.(createdAccount);
    } catch (err) {
      console.debug('Failed to create connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to create connection. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  const renderField = (field: ConnectorSettingDefinition) => {
    if (field.type === 'boolean') {
      return (
        <Checkbox
          key={field.key}
          label={field.label}
          description={field.description}
          checked={!!fieldValues[field.key]}
          onChange={(e) => setFieldValue(field.key, e.currentTarget.checked)}
        />
      );
    }
    if (field.type === 'password') {
      return (
        <PasswordInput
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          description={field.description}
          value={(fieldValues[field.key] as string) ?? ''}
          onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
        />
      );
    }
    return (
      <TextInput
        key={field.key}
        label={field.label}
        placeholder={field.placeholder}
        description={field.description}
        value={(fieldValues[field.key] as string) ?? ''}
        onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
      />
    );
  };

  const serviceName = newService ? getServiceName(metadata, newService) : '';

  if (newService === 'GENERIC_API') {
    return (
      <GenericApiConnectionModal
        opened={opened}
        onClose={() => {
          handleClearForm();
          onClose();
        }}
        workbookId={workbookId}
        onConnectionCreated={(account) => {
          handleClearForm();
          onConnectionCreated?.(account);
        }}
      />
    );
  }

  return (
    <Modal
      opened={opened}
      onClose={() => {
        handleClearForm();
        onClose();
      }}
      title="Create Connection"
      size="lg"
      centered
    >
      {isOAuthLoading || isCreating ? (
        <Center py="xl">
          <Stack align="center" gap="md">
            <Loader size="md" />
            <Text size="sm" c="dimmed">
              {isOAuthLoading
                ? `Waiting for authentication with ${serviceName}...`
                : `Verifying connection to ${serviceName}...`}
            </Text>
            {isOAuthLoading && (
              <ButtonSecondaryOutline
                onClick={() => {
                  setIsOAuthLoading(false);
                }}
              >
                Cancel
              </ButtonSecondaryOutline>
            )}
          </Stack>
        </Center>
      ) : (
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="space-between" align="baseline" mb={4}>
            <Text size="sm" fw={500}>
              App
            </Text>
            {availableServices.includes('GENERIC_API') && (
              <Text size="xs" c="dimmed">
                Not finding your App:{' '}
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  onClick={() => handleSelectNewService('GENERIC_API')}
                >
                  Bring your own API
                </Anchor>
              </Text>
            )}
          </Group>
          <SimpleGrid cols={3} spacing="xs" mb="xs">
            {availableServices
              .filter((s) => s !== 'GENERIC_API')
              .map((service) => {
                const isSelected = newService === service;
                return (
                  <UnstyledButton
                    key={service}
                    onClick={() => handleSelectNewService(service)}
                    style={{
                      border: `0.5px solid ${isSelected ? 'var(--mantine-color-teal-4)' : 'var(--mantine-color-gray-3)'}`,
                      padding: '6px 8px',
                      backgroundColor: isSelected ? 'var(--mantine-color-teal-0)' : 'transparent',
                      borderRadius: 6,
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap">
                        <ConnectorIcon connector={service} size={20} />
                        <Text size="sm" fw={500}>
                          {getServiceName(metadata, service)}
                        </Text>
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
            error={isDisplayNameTaken ? 'A connection with this name already exists in this workspace.' : undefined}
            onChange={(e) => setNewDisplayName(e.currentTarget.value)}
          />

          {/* Authentication Method */}
          <Stack style={{ minHeight: 150 }}>
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
                onChange={(value) => {
                  setAuthMethod(value as AuthMethod);
                  setFieldValues({});
                }}
              >
                <Group gap="xs" mt="xs">
                  {getSupportedAuthMethods(newService).includes('oauth') && (
                    <Radio value="oauth" label={getOauthLabel(metadata, newService)} />
                  )}
                  {getSupportedAuthMethods(newService).includes('user_provided_params') && (
                    <Radio
                      value="user_provided_params"
                      label={metadata?.[newService]?.userProvidedParamsLabel ?? 'API Key'}
                    />
                  )}
                  {showOAuthCustom && getSupportedAuthMethods(newService).includes('oauth_custom') && (
                    <Radio value="oauth_custom" label={getOauthPrivateLabel(metadata, newService)} />
                  )}
                </Group>
              </Radio.Group>
            )}
            {authMethod === 'oauth_custom' && (
              <>
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
            {newService && metadata?.[newService]?.setupGuide && (
              <Alert color="blue" title="Setup Guide">
                <Anchor href={metadata[newService].setupGuide?.url} target="_blank" rel="noreferrer">
                  {metadata[newService].setupGuide?.label}
                </Anchor>
              </Alert>
            )}
            {currentFields.length > 0 && <Stack>{currentFields.map((field) => renderField(field))}</Stack>}
          </Stack>

          <Group justify="flex-end" gap="sm" mt="md">
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={() => void handleCreate()} loading={isCreating} disabled={isDisplayNameTaken}>
              {authMethod === 'oauth' && newService ? 'Connect with ' + serviceName : 'Create'}
            </ButtonPrimaryLight>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
