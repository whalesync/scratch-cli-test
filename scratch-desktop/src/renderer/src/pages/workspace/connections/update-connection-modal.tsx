import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Alert, Checkbox, Group, Modal, PasswordInput, Stack, TextInput } from '@mantine/core';
import { AuthType, type ConnectorAccount, type ConnectorSettingDefinition } from '@spinner/shared-types';
import { useEffect, useState } from 'react';
import { GenericApiConnectionModal } from './generic-api-connection-modal';

interface UpdateConnectionModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  connectorAccount: ConnectorAccount;
}

export function UpdateConnectionModal({ opened, onClose, workbookId, connectorAccount }: UpdateConnectionModalProps) {
  // Delegate to GenericApiConnectionModal for GENERIC_API connections
  if (connectorAccount.service === 'GENERIC_API') {
    return (
      <GenericApiConnectionModal
        opened={opened}
        onClose={onClose}
        workbookId={workbookId}
        existingAccount={connectorAccount}
      />
    );
  }

  return (
    <StandardUpdateConnectionModal
      opened={opened}
      onClose={onClose}
      workbookId={workbookId}
      connectorAccount={connectorAccount}
    />
  );
}

function StandardUpdateConnectionModal({ opened, onClose, workbookId, connectorAccount }: UpdateConnectionModalProps) {
  const { data: metadata } = useConnectorsMetadata();
  const [updatedName, setUpdatedName] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { updateConnectorAccount } = useConnectorAccounts(workbookId);

  const credentialFields: ConnectorSettingDefinition[] =
    metadata?.[connectorAccount.service]?.credentialFields?.user_provided_params ?? [];

  useEffect(() => {
    if (opened) {
      setUpdatedName(connectorAccount.displayName);
      setFieldValues({});
      setError(null);
    }
  }, [opened, connectorAccount]);

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleUpdate = async () => {
    setIsSaving(true);
    try {
      let userProvidedParams: Record<string, string> | undefined;

      const hasAnyValue = credentialFields.some((f) => {
        const val = fieldValues[f.key];
        return typeof val === 'string' ? !!val : false;
      });

      if (hasAnyValue) {
        userProvidedParams = {};
        for (const field of credentialFields) {
          const val = fieldValues[field.key];
          if (typeof val === 'string') {
            userProvidedParams[field.key] = val;
          }
        }
      }

      await updateConnectorAccount(connectorAccount.id, {
        displayName: updatedName,
        ...(userProvidedParams && { userProvidedParams }),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An unknown error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const isUserProvidedParams = connectorAccount.authType === AuthType.USER_PROVIDED_PARAMS;

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
    <Modal opened={opened} onClose={onClose} title="Edit Connection" size="md" centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <TextInput label="Display Name" value={updatedName} onChange={(e) => setUpdatedName(e.currentTarget.value)} />

        {isUserProvidedParams && credentialFields.length > 0 && (
          <Stack>{credentialFields.map((field) => renderField(field))}</Stack>
        )}

        <Group justify="flex-end" gap="sm" mt="md">
          <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight loading={isSaving} onClick={() => void handleUpdate()}>
            Save
          </ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
}
