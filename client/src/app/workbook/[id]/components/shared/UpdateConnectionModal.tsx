import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Alert, Checkbox, ModalProps, PasswordInput, Stack, TextInput } from '@mantine/core';
import { AuthType, ConnectorAccount, ConnectorSettingDefinition } from '@spinner/shared-types';
import { useEffect, useState } from 'react';
import { GenericApiConnectionModal } from './GenericApiConnectionModal';

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
    return (
      <GenericApiConnectionModal
        {...modalProps}
        workbookId={workbook.id}
        existingAccount={connectorAccount}
      />
    );
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

  useEffect(() => {
    if (connectorAccount) {
      setUpdatedName(connectorAccount.displayName);
      setUpdatedModifier(connectorAccount.modifier);
    }
  }, [connectorAccount]);

  const setFieldValue = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleUpdate = async () => {
    if (!connectorAccount) return;
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

      await updateConnectorAccount(connectorAccount.id, {
        displayName: updatedName,
        ...(userProvidedParams && { userProvidedParams }),
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
      }}
    >
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <TextInput label="Display Name" value={updatedName} onChange={(e) => setUpdatedName(e.currentTarget.value)} />

        {isUserProvidedParams && credentialFields.length > 0 && (
          <Stack>{credentialFields.map((field) => renderField(field))}</Stack>
        )}
      </Stack>
    </ModalWrapper>
  );
};
