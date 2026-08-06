import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Alert, Checkbox, Group, Modal, PasswordInput, Stack, TextInput } from '@mantine/core';
import { AuthType, type ConnectorAccount, type ConnectorSettingDefinition } from '@spinner/shared-types';
import { useEffect, useState } from 'react';
import { credentialFieldValidationError, stringListRowsFromAccountExtras } from './credential-field-helpers';
import { GenericApiConnectionModal } from './generic-api-connection-modal';
import { StringListCredentialField } from './string-list-credential-field';

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

  // Connect-form fields that persist verbatim rows in extras (`extrasKey`, e.g.
  // Google Sheets' spreadsheet URLs) stay editable after connect: prefill the
  // rows from extras and write them back on save. All generic — the key comes
  // from metadata, the values are the user's own input.
  const extrasBackedFields: ConnectorSettingDefinition[] = (
    (connectorAccount.authType === AuthType.OAUTH
      ? metadata?.[connectorAccount.service]?.credentialFields?.oauth
      : undefined) ?? []
  ).filter((field) => field.type === 'string-list' && field.extrasKey !== undefined);
  const [extrasFieldRows, setExtrasFieldRows] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (opened) {
      setUpdatedName(connectorAccount.displayName);
      setFieldValues({});
      setExtrasFieldRows(
        Object.fromEntries(
          extrasBackedFields.map((field) => [
            field.key,
            stringListRowsFromAccountExtras(field, connectorAccount.extras),
          ]),
        ),
      );
      setError(null);
    }
    // extrasBackedFields is derived from connectorAccount + static metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, connectorAccount, metadata]);

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleUpdate = async () => {
    // Validate extras-backed rows (required + per-row pattern) before saving.
    for (const field of extrasBackedFields) {
      const validationError = credentialFieldValidationError(field, extrasFieldRows[field.key]);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

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

      // Rewrite the extras-backed rows (trimmed, blanks dropped) on top of the
      // account's existing extras — only when such fields exist, so other
      // connectors' extras are never touched from here.
      let updatedExtras: Record<string, unknown> | undefined;
      if (extrasBackedFields.length > 0) {
        updatedExtras = { ...(connectorAccount.extras ?? {}) };
        for (const field of extrasBackedFields) {
          if (field.extrasKey === undefined) continue;
          updatedExtras[field.extrasKey] = (extrasFieldRows[field.key] ?? [])
            .map((row) => row.trim())
            .filter((row) => row.length > 0);
        }
      }

      await updateConnectorAccount(connectorAccount.id, {
        displayName: updatedName,
        ...(userProvidedParams && { userProvidedParams }),
        ...(updatedExtras && { extras: updatedExtras }),
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

        {extrasBackedFields.map((field) => (
          <StringListCredentialField
            key={field.key}
            field={field}
            rows={extrasFieldRows[field.key] ?? []}
            onChange={(rows) => setExtrasFieldRows((prev) => ({ ...prev, [field.key]: rows }))}
          />
        ))}

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
