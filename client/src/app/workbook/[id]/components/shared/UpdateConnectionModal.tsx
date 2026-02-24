import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { Alert, Group, ModalProps, PasswordInput, Stack, TextInput } from '@mantine/core';
import { AuthType, ConnectorAccount, Service } from '@spinner/shared-types';
import { useEffect, useState } from 'react';

interface UpdateConnectionModalProps extends ModalProps {
  connectorAccount: ConnectorAccount | null;
}

export const UpdateConnectionModal = (props: UpdateConnectionModalProps) => {
  const { connectorAccount, ...modalProps } = props;
  const { workbook } = useActiveWorkbook();
  const [updatedName, setUpdatedName] = useState('');
  const [updatedApiKey, setUpdatedApiKey] = useState('');
  const [updatedUsername, setUpdatedUsername] = useState('');
  const [updatedPassword, setUpdatedPassword] = useState('');
  const [updatedEndpoint, setUpdatedEndpoint] = useState('');
  const [updatedModifier, setUpdatedModifier] = useState<string | null>(null);
  const [updatedDomain, setUpdatedDomain] = useState('');
  const [updatedShopDomain, setUpdatedShopDomain] = useState('');
  const [updatedConnectionString, setUpdatedConnectionString] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { updateConnectorAccount } = useConnectorAccounts(workbook?.id);

  useEffect(() => {
    if (connectorAccount) {
      setUpdatedName(connectorAccount.displayName);
      setUpdatedModifier(connectorAccount.modifier);
    }
  }, [connectorAccount]);

  const handleUpdate = async () => {
    if (!connectorAccount) return;
    setIsSaving(true);
    try {
      // Build userProvidedParams only if user has entered values
      let userProvidedParams: Record<string, string> | undefined = undefined;

      if (connectorAccount.service === Service.WORDPRESS) {
        if (updatedUsername || updatedPassword || updatedEndpoint) {
          userProvidedParams = {
            username: updatedUsername,
            password: updatedPassword,
            endpoint: updatedEndpoint,
          };
        }
      } else if (connectorAccount.service === Service.MOCO) {
        if (updatedDomain || updatedApiKey) {
          userProvidedParams = { domain: updatedDomain, apiKey: updatedApiKey };
        }
      } else if (connectorAccount.service === Service.SHOPIFY) {
        if (updatedShopDomain || updatedApiKey) {
          userProvidedParams = { shopDomain: updatedShopDomain, apiKey: updatedApiKey };
        }
      } else if (connectorAccount.service === Service.POSTGRES || connectorAccount.service === Service.SUPABASE) {
        if (updatedConnectionString) {
          userProvidedParams = { connectionString: updatedConnectionString };
        }
      } else {
        if (updatedApiKey) {
          userProvidedParams = { apiKey: updatedApiKey };
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
        setUpdatedApiKey('');
        setUpdatedUsername('');
        setUpdatedPassword('');
        setUpdatedEndpoint('');
        setUpdatedDomain('');
        setUpdatedShopDomain('');
        setUpdatedConnectionString('');
        setError(null);
      }}
    >
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <TextInput label="Display Name" value={updatedName} onChange={(e) => setUpdatedName(e.currentTarget.value)} />

        {isUserProvidedParams && connectorAccount?.service === Service.WORDPRESS && (
          <Stack>
            <Group grow>
              <TextInput
                label="Username"
                placeholder="Enter your WordPress username"
                value={updatedUsername}
                onChange={(e) => setUpdatedUsername(e.currentTarget.value)}
              />
              <PasswordInput
                label="Application password"
                placeholder="Enter your application password here"
                value={updatedPassword}
                onChange={(e) => setUpdatedPassword(e.currentTarget.value)}
              />
            </Group>
            <TextInput
              label="WordPress URL"
              placeholder="Enter the address of your WordPress site here"
              value={updatedEndpoint}
              onChange={(e) => setUpdatedEndpoint(e.currentTarget.value)}
            />
          </Stack>
        )}

        {isUserProvidedParams && connectorAccount?.service === Service.SHOPIFY && (
          <Stack>
            <TextInput
              label="Shop Domain"
              placeholder="your-store.myshopify.com"
              description="Your Shopify store domain (e.g., your-store.myshopify.com)"
              value={updatedShopDomain}
              onChange={(e) => setUpdatedShopDomain(e.currentTarget.value)}
            />
            <PasswordInput
              label="Admin API Access Token"
              placeholder="shpat_..."
              description="Create a custom app in Settings > Apps > Develop apps to get an access token"
              value={updatedApiKey}
              onChange={(e) => setUpdatedApiKey(e.currentTarget.value)}
            />
          </Stack>
        )}

        {isUserProvidedParams && connectorAccount?.service === Service.MOCO && (
          <Stack>
            <TextInput
              label="Moco Domain"
              placeholder="yourcompany"
              description="Your Moco subdomain (e.g., 'yourcompany' from yourcompany.mocoapp.com)"
              value={updatedDomain}
              onChange={(e) => setUpdatedDomain(e.currentTarget.value)}
            />
            <PasswordInput
              label="API Key"
              placeholder="Enter your Moco API key"
              description="Generate an API key in your Moco account under Integrations"
              value={updatedApiKey}
              onChange={(e) => setUpdatedApiKey(e.currentTarget.value)}
            />
          </Stack>
        )}

        {isUserProvidedParams && connectorAccount?.service === Service.POSTGRES && (
          <PasswordInput
            label="Connection String"
            placeholder="postgres://user:password@host:5432/database"
            value={updatedConnectionString}
            onChange={(e) => setUpdatedConnectionString(e.currentTarget.value)}
          />
        )}

        {isUserProvidedParams && connectorAccount?.service === Service.SUPABASE && (
          <PasswordInput
            label="Connection String"
            placeholder="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"
            description="Find this in your Supabase project under Settings > Database > Connection string"
            value={updatedConnectionString}
            onChange={(e) => setUpdatedConnectionString(e.currentTarget.value)}
          />
        )}

        {isUserProvidedParams &&
          connectorAccount?.service !== Service.WORDPRESS &&
          connectorAccount?.service !== Service.SHOPIFY &&
          connectorAccount?.service !== Service.MOCO &&
          connectorAccount?.service !== Service.POSTGRES &&
          connectorAccount?.service !== Service.SUPABASE && (
            <PasswordInput
              label="API Key"
              value={updatedApiKey}
              placeholder="Enter your new API key, secret or token"
              onChange={(e) => setUpdatedApiKey(e.currentTarget.value)}
            />
          )}
      </Stack>
    </ModalWrapper>
  );
};
