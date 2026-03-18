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
import { ConnectorSettingDefinition, OAuthInitiateOptionsDto } from '@spinner/shared-types';
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
  const [newService, setNewService] = useState<string | null>(null);
  const [newModifier, setNewModifier] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('oauth');

  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [isOAuthLoading, setIsOAuthLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [showOAuthCustom, setShowOAuthCustom] = useState(false);
  const { metadata } = useConnectorsMetadata();
  const { canCreateDataSource } = useSubscription();
  const { createConnectorAccount } = useConnectorAccounts(workbookId);
  const { getDefaultAuthMethod, getSupportedAuthMethods, availableServices } = useConnectors();

  const currentFields: ConnectorSettingDefinition[] =
    (newService ? metadata?.[newService]?.credentialFields?.[authMethod] : undefined) ?? [];

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSelectNewService = (service: string) => {
    setNewService(service);
    setNewDisplayName(getServiceName(metadata, service));
    setAuthMethod(getDefaultAuthMethod(service));
    setCustomClientId('');
    setCustomClientSecret('');
    setFieldValues({});
  };

  const handleClearForm = () => {
    setFieldValues({});
    setNewService(null);
    setNewModifier(null);
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
      const returnPage = returnUrl ?? window.location.pathname;
      console.debug('connectionName', connectionName);

      const oauthOptions: OAuthInitiateOptionsDto = {
        // (http|https)://<host, e.g. test.scratch.md>
        redirectPrefix: `${window.location.protocol}//${window.location.host}`,
        workbookId: workbookId,
        connectionMethod: isCustom ? 'OAUTH_CUSTOM' : 'OAUTH_SYSTEM',
        customClientId: isCustom ? customClientId : undefined,
        customClientSecret: isCustom ? customClientSecret : undefined,
        connectionName: connectionName,
        returnPage: returnPage,
      };
      // Assign credential field values to the options (keys match OAuthInitiateOptionsDto properties)
      for (const field of currentFields) {
        const val = fieldValues[field.key];
        if (val !== undefined && val !== '') {
          (oauthOptions as Record<string, unknown>)[field.key] = val;
        }
      }
      await initiateOAuth(newService, oauthOptions);
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
      // For OAuth, the connection will be created in the callback page
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
          {/* Private OAuth credentials (oauth_custom) */}
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
          {/* Data-driven credential fields for the current auth method */}
          {currentFields.length > 0 && <Stack>{currentFields.map((field) => renderField(field))}</Stack>}
        </Stack>
      </Stack>
    </ModalWrapper>
  );
};
