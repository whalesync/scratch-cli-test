import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Alert, Checkbox, ModalProps, PasswordInput, Stack, TextInput } from '@mantine/core';
import {
  AuthType,
  ConnectorAccount,
  ConnectorSettingDefinition,
  describeSecretsToReenterForConnectionTargetChange,
  isNonBlankCredentialValue,
  resolveSecretFieldsToReenterForConnectionTargetEdit,
} from '@spinner/shared-types';
import { useState } from 'react';
import { GenericApiConnectionModal } from './GenericApiConnectionModal';
import { PemCredentialField } from './PemCredentialField';
import {
  credentialFieldValidationError,
  StringListCredentialField,
  stringListRowsFromAccountExtras,
} from './StringListCredentialField';

interface UpdateConnectionModalProps extends ModalProps {
  connectorAccount: ConnectorAccount | null;
}

export const UpdateConnectionModal = (props: UpdateConnectionModalProps) => {
  const { connectorAccount, ...modalProps } = props;
  const { workbook } = useActiveWorkbook();

  // GENERIC_API uses the same custom modal as create — endpoint editing,
  // AI-assist, structured extras are too rich for the data-driven field
  // form the StandardUpdateForm renders.
  if (connectorAccount?.service === 'GENERIC_API' && workbook?.id) {
    return <GenericApiConnectionModal {...modalProps} workbookId={workbook.id} existingAccount={connectorAccount} />;
  }
  return <StandardUpdateForm {...props} />;
};

const StandardUpdateForm = (props: UpdateConnectionModalProps) => {
  const { connectorAccount, ...modalProps } = props;
  const { workbook } = useActiveWorkbook();
  const { metadata } = useConnectorsMetadata();
  const [updatedName, setUpdatedName] = useState('');
  const [updatedModifier, setUpdatedModifier] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { updateConnectorAccount } = useConnectorAccounts(workbook?.id);

  const credentialFields: ConnectorSettingDefinition[] =
    (connectorAccount?.service
      ? metadata?.[connectorAccount.service]?.credentialFields?.user_provided_params
      : undefined) ?? [];

  // Pointing the connection somewhere new (a site URL, a shop domain) means entering its secrets again, or the server
  // refuses the edit (DEV-12723). Ask for them as soon as a target field has a value, in the server's own words.
  const { connectionTargetFieldsBeingEdited, secretFieldsToReenter } =
    resolveSecretFieldsToReenterForConnectionTargetEdit(credentialFields, fieldValues);
  const secretFieldKeysToReenter = new Set(secretFieldsToReenter.map((field) => field.key));
  const secretsToReenterMessage =
    secretFieldsToReenter.length > 0
      ? describeSecretsToReenterForConnectionTargetChange(
          secretFieldsToReenter.map((field) => field.label),
          connectionTargetFieldsBeingEdited.map((field) => field.label),
        )
      : null;

  // Connect-form fields that persist verbatim rows in extras (`extrasKey`, e.g.
  // Google Sheets' spreadsheet URLs) stay editable after connect: prefill the
  // rows from extras and write them back on save. All generic — the key comes
  // from metadata, the values are the user's own input.
  const extrasBackedFields: ConnectorSettingDefinition[] = (
    (connectorAccount?.service && connectorAccount.authType === AuthType.OAUTH
      ? metadata?.[connectorAccount.service]?.credentialFields?.oauth
      : undefined) ?? []
  ).filter((field) => field.type === 'string-list' && field.extrasKey !== undefined);
  const [extrasFieldRows, setExtrasFieldRows] = useState<Record<string, string[]>>({});

  // (Re)initialize the form whenever the account or the connectors metadata changes. Metadata loads asynchronously
  // and drives extrasBackedFields, so it must re-trigger too. Done during render rather than in an effect.
  const [previousFormInitializationSource, setPreviousFormInitializationSource] = useState<{
    connectorAccount: typeof connectorAccount;
    metadata: typeof metadata;
  } | null>(null);
  if (
    previousFormInitializationSource === null ||
    previousFormInitializationSource.connectorAccount !== connectorAccount ||
    previousFormInitializationSource.metadata !== metadata
  ) {
    setPreviousFormInitializationSource({ connectorAccount, metadata });
    if (connectorAccount) {
      setUpdatedName(connectorAccount.displayName);
      setUpdatedModifier(connectorAccount.modifier);
      setExtrasFieldRows(
        Object.fromEntries(
          extrasBackedFields.map((field) => [
            field.key,
            stringListRowsFromAccountExtras(field, connectorAccount.extras),
          ]),
        ),
      );
    }
  }

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleUpdate = async () => {
    if (!connectorAccount) return;

    if (
      secretsToReenterMessage &&
      secretFieldsToReenter.some((field) => !isNonBlankCredentialValue(fieldValues[field.key]))
    ) {
      setError(secretsToReenterMessage);
      return;
    }

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
      // Build userProvidedParams only if user has entered values
      let userProvidedParams: Record<string, string> | undefined = undefined;

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
      let updatedExtras: Record<string, unknown> | undefined = undefined;
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
        modifier: updatedModifier || undefined,
      });
      ScratchpadNotifications.success({
        message: `Connection ${updatedName} updated successfully`,
      });
      props.onClose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An unknown error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const isUserProvidedParams = connectorAccount?.authType === AuthType.USER_PROVIDED_PARAMS;

  const renderField = (field: ConnectorSettingDefinition) => {
    if (field.format === 'pem') {
      return (
        <PemCredentialField
          key={field.key}
          field={field}
          value={(fieldValues[field.key] as string) ?? ''}
          onChange={(pemText) => setFieldValue(field.key, pemText)}
        />
      );
    }
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
      const isSecretToReenter = secretFieldKeysToReenter.has(field.key);
      return (
        <PasswordInput
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          description={isSecretToReenter ? secretsToReenterMessage : field.description}
          required={isSecretToReenter}
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
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline variant="default" onClick={props.onClose}>
              Cancel
            </ButtonSecondaryOutline>
            <ButtonPrimaryLight loading={isSaving} onClick={handleUpdate}>
              Save
            </ButtonPrimaryLight>
          </>
        ),
      }}
      title="Edit Connection"
      centered
      {...modalProps}
      onExitTransitionEnd={() => {
        setFieldValues({});
        setError(null);
        // Re-prefill the extras-backed rows so a same-account reopen doesn't
        // show stale unsaved edits (the connectorAccount effect only fires on
        // account change).
        setExtrasFieldRows(
          Object.fromEntries(
            extrasBackedFields.map((field) => [
              field.key,
              stringListRowsFromAccountExtras(field, connectorAccount?.extras),
            ]),
          ),
        );
      }}
    >
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
      </Stack>
    </ModalWrapper>
  );
};
