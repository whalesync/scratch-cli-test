import { Badge, BadgeError, BadgeOK } from '@/app/components/base/badge';
import { ButtonPrimaryLight } from '@/app/components/base/buttons';
import { Text13Book, TextTitle2, TextTitle3, TextTitle4 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { LabelValuePair } from '@/app/components/LabelValuePair';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { ToolIconButton } from '@/app/components/ToolIconButton';
import { devToolsApi } from '@/lib/api/dev-tools';
import { UserDetails } from '@/types/server-entities/dev-tools';
import { User } from '@/types/server-entities/users';
import { getBuildFlavor } from '@/utils/build';
import {
  Accordion,
  Anchor,
  Card,
  Checkbox,
  CloseButton,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { ConnectorAccountId, IdPrefixes } from '@spinner/shared-types';
import {
  BuildingIcon,
  CreditCardIcon,
  FolderIcon,
  HatGlassesIcon,
  LockKeyholeIcon,
  LogsIcon,
  PiggyBankIcon,
  SquarePenIcon,
  Trash2Icon,
  UserCogIcon,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { clerkUserUrl, posthogPersonUrl, stripeCustomerUrl } from '../utils';

export const UserDetailsCard = ({
  details,
  onClose,
  onRefreshUser,
}: {
  details: UserDetails;
  onClose: () => void;
  onRefreshUser: (userId: string) => void;
}) => {
  const [saving, setSaving] = useState(false);
  const [newOrgId, setNewOrgId] = useState('');
  const [deleteOldOrg, setDeleteOldOrg] = useState(false);
  const [activeWorkbookTab, setActiveWorkbookTab] = useState<string | null>(details.workbooks[0]?.id ?? null);
  const [credentialsMap, setCredentialsMap] = useState<Record<string, Record<string, unknown> | null>>({});
  const [loadingCredentials, setLoadingCredentials] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setActiveWorkbookTab(details.workbooks[0]?.id ?? null);
    setCredentialsMap({});
    setLoadingCredentials({});
  }, [details]);

  const { open: openConfirm, dialogProps } = useConfirmDialog();
  const orgIdError =
    newOrgId.trim() && !newOrgId.trim().startsWith(IdPrefixes.ORGANIZATION)
      ? 'Organization ID must start with "org_"'
      : undefined;

  const handleChangeOrganization = useCallback(() => {
    if (!newOrgId.trim() || !newOrgId.trim().startsWith(IdPrefixes.ORGANIZATION)) return;

    openConfirm({
      title: 'Change Organization',
      message: `Move user "${details.user.name}" to organization "${newOrgId}"?${deleteOldOrg ? ' The old organization will be deleted if no other users remain.' : ''}`,
      confirmLabel: 'Change Organization',
      variant: 'danger',
      onConfirm: async () => {
        try {
          setSaving(true);
          await devToolsApi.changeUserOrganization({
            userId: details.user.id,
            newOrganizationId: newOrgId.trim(),
            deleteOldOrganization: deleteOldOrg,
          });
          ScratchpadNotifications.success({
            title: 'Organization changed',
            message: 'The user organization has been updated successfully',
          });
          setNewOrgId('');
          setDeleteOldOrg(false);
          onRefreshUser(details.user.id);
        } catch (error) {
          console.error('Failed to change organization', error);
          ScratchpadNotifications.error({
            title: 'Failed to change organization',
            message: 'The user organization has not been updated',
          });
        } finally {
          setSaving(false);
        }
      },
    });
  }, [newOrgId, deleteOldOrg, details, openConfirm, onRefreshUser]);

  const handleViewCredentials = useCallback(
    async (connectionId: string) => {
      if (credentialsMap[connectionId] !== undefined) {
        setCredentialsMap((prev) => {
          const next = { ...prev };
          delete next[connectionId];
          return next;
        });
        return;
      }
      try {
        setLoadingCredentials((prev) => ({ ...prev, [connectionId]: true }));
        const result = await devToolsApi.getConnectionCredentials(connectionId as ConnectorAccountId);
        setCredentialsMap((prev) => ({ ...prev, [connectionId]: result.credentials }));
      } catch (error) {
        console.error('Failed to get credentials', error);
        ScratchpadNotifications.error({
          title: 'Failed to get credentials',
          message: 'Could not retrieve credentials for this connection',
        });
      } finally {
        setLoadingCredentials((prev) => ({ ...prev, [connectionId]: false }));
      }
    },
    [credentialsMap],
  );

  const handleRemoveSetting = useCallback(
    async (key: string) => {
      try {
        setSaving(true);
        await devToolsApi.updateUserSettings(details.user.id, { updates: { [key]: null } });
        ScratchpadNotifications.success({
          title: 'Setting removed successfully',
          message: 'The setting has been removed successfully',
        });
        onRefreshUser(details.user.id);
      } catch (error) {
        console.error('Failed to remove setting', key, error);
        ScratchpadNotifications.error({
          title: 'Failed to remove setting',
          message: 'The setting has not been removed',
        });
      } finally {
        setSaving(false);
      }
    },
    [details, onRefreshUser],
  );

  return (
    <Card withBorder shadow="sm" radius="xs">
      <Card.Section withBorder inheritPadding py="xs">
        <Group justify="space-between">
          <TextTitle2>User Details: {details.user.name}</TextTitle2>
          <CloseButton onClick={onClose} />
        </Group>
      </Card.Section>
      <Card.Section mt="sm" p="xs" withBorder>
        <SimpleGrid cols={2} spacing="md">
          <Stack>
            <LabelValuePair label="ID" value={details.user.id} canCopy />
            <LabelValuePair label="Name" value={details.user.name} />
            <LabelValuePair label="Email" value={details.user.email} canCopy />
            <LabelValuePair label="Joined" value={new Date(details.user.createdAt).toLocaleString()} />
            <LabelValuePair label="Last Active" value={new Date(details.user.updatedAt).toLocaleString()} />
            <LabelValuePair label="Subscription Status" value={<SubscriptionInfo user={details.user} />} />
          </Stack>
          <Stack>
            <Group align="center" gap="xs">
              <LabelValuePair label="Clerk ID" value={details.user.clerkId} canCopy />
              {details.user.clerkId && (
                <Tooltip label="View in Clerk">
                  <Anchor href={clerkUserUrl(details.user.clerkId, getBuildFlavor())} target="_blank" rel="noreferrer">
                    <StyledLucideIcon Icon={HatGlassesIcon} size={16} />
                  </Anchor>
                </Tooltip>
              )}
            </Group>
            <Group align="center" gap="xs">
              {details.user.stripeCustomerId ? (
                <LabelValuePair label="Stripe Customer ID" value={details.user.stripeCustomerId} canCopy />
              ) : (
                <LabelValuePair label="Stripe Customer ID" value="NONE FOUND!" />
              )}
              {details.user.stripeCustomerId && (
                <Tooltip label="View in Stripe">
                  <Anchor
                    href={stripeCustomerUrl(details.user.stripeCustomerId, getBuildFlavor())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <StyledLucideIcon Icon={CreditCardIcon} size={16} />
                  </Anchor>
                </Tooltip>
              )}
            </Group>
            <Group align="center" gap="xs">
              <LabelValuePair label="PostHog" value="Sessions" />
              <Tooltip label="View in PostHog">
                <Anchor href={posthogPersonUrl(details.user.id, getBuildFlavor())} target="_blank" rel="noreferrer">
                  <StyledLucideIcon Icon={PiggyBankIcon} size={16} />
                </Anchor>
              </Tooltip>
            </Group>
          </Stack>
        </SimpleGrid>
      </Card.Section>
      <Card.Section p="xs" withBorder>
        <Stack>
          <Group gap="xs">
            <StyledLucideIcon Icon={BuildingIcon} size={14} c="var(--fg-secondary)" />
            <TextTitle3>Organization</TextTitle3>
          </Group>
          <LabelValuePair label="ID" value={details.user.organization?.id} canCopy />
          <LabelValuePair label="Clerk ID" value={details.user.organization?.clerkId} canCopy />
          <LabelValuePair label="Name" value={details.user.organization?.name} />
          <Accordion variant="contained" defaultValue={null} chevronPosition="right">
            <Accordion.Item value="change-org">
              <Accordion.Control icon={<SquarePenIcon size={12} />}>Change Organization</Accordion.Control>
              <Accordion.Panel>
                <Group gap="xs" grow justify="space-between" align="center">
                  <TextInput
                    placeholder="Enter organization ID"
                    size="xs"
                    value={newOrgId}
                    onChange={(e) => setNewOrgId(e.currentTarget.value)}
                    error={orgIdError}
                    disabled={saving}
                    miw="50%"
                  />
                  <Checkbox
                    label="Remove old org"
                    checked={deleteOldOrg}
                    onChange={(e) => setDeleteOldOrg(e.currentTarget.checked)}
                    disabled={saving}
                  />

                  <ButtonPrimaryLight
                    onClick={handleChangeOrganization}
                    loading={saving}
                    disabled={!newOrgId.trim() || !!orgIdError}
                    size="xs"
                  >
                    Change Organization
                  </ButtonPrimaryLight>
                </Group>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
        <ConfirmDialog {...dialogProps} />
      </Card.Section>
      <Card.Section p="xs" withBorder>
        <Stack>
          <Group gap="xs">
            <StyledLucideIcon Icon={UserCogIcon} size={14} c="var(--fg-secondary)" />
            <TextTitle3>User Settings</TextTitle3>
          </Group>
          {Object.entries(details.user.settings ?? {}).map(([key, value]) => (
            <LabelValuePair
              key={key}
              label={key}
              value={
                <Group justify="space-between" w="100%">
                  <Text13Book>{value}</Text13Book>
                  <ToolIconButton
                    icon={Trash2Icon}
                    onClick={() => handleRemoveSetting(key)}
                    tooltip="Remove this setting"
                    disabled={saving}
                  />
                </Group>
              }
            />
          ))}
          {Object.keys(details.user.settings ?? {}).length === 0 && <Text13Book>No custom settings</Text13Book>}
        </Stack>
      </Card.Section>
      <Card.Section p="xs" withBorder>
        <Stack>
          <Group gap="xs">
            <StyledLucideIcon Icon={FolderIcon} size={14} c="var(--fg-secondary)" />
            <TextTitle3>Workspaces</TextTitle3>
          </Group>
          {details.workbooks.length > 0 && (
            <Tabs value={activeWorkbookTab} onChange={setActiveWorkbookTab}>
              <Tabs.List>
                {details.workbooks.map((workbook) => (
                  <Tabs.Tab key={workbook.id} value={workbook.id}>
                    {workbook.name}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {details.workbooks.map((workbook) => (
                <Tabs.Panel key={workbook.id} value={workbook.id} pt="sm">
                  <Stack gap="sm">
                    <LabelValuePair label="ID" value={workbook.id} canCopy />
                    <LabelValuePair
                      label="Status"
                      value={
                        workbook.isPendingDelete ? <BadgeError>Pending Deletion</BadgeError> : <BadgeOK>Active</BadgeOK>
                      }
                    />
                    <LabelValuePair label="Tables" value={String(workbook.numTables)} />
                    <TextTitle4>Data Folders</TextTitle4>
                    {workbook.dataFolders.length > 0 ? (
                      <Table>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Name</Table.Th>
                            <Table.Th>Path</Table.Th>
                            <Table.Th>Service</Table.Th>
                            <Table.Th>Lock</Table.Th>
                            <Table.Th>Last Sync</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {workbook.dataFolders.map((df) => (
                            <Table.Tr key={df.path ?? df.name}>
                              <Table.Td>{df.name}</Table.Td>
                              <Table.Td>{df.path ?? '-'}</Table.Td>
                              <Table.Td>{df.connectorService ?? '-'}</Table.Td>
                              <Table.Td>{df.lock ?? '-'}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    ) : (
                      <Text13Book>No data folders</Text13Book>
                    )}
                    <TextTitle4>Connections</TextTitle4>
                    {workbook.connections.length > 0 ? (
                      <Table>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th w="120px">ID</Table.Th>
                            <Table.Th>Name</Table.Th>
                            <Table.Th>Service</Table.Th>
                            <Table.Th>Created</Table.Th>
                            <Table.Th w="40px" />
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {workbook.connections.map((connection) => (
                            <Fragment key={connection.id}>
                              <Table.Tr>
                                <Table.Td>{connection.id}</Table.Td>
                                <Table.Td>{connection.name}</Table.Td>
                                <Table.Td>{connection.service}</Table.Td>
                                <Table.Td>{new Date(connection.createdAt).toLocaleDateString()}</Table.Td>
                                <Table.Td>
                                  <ToolIconButton
                                    icon={LockKeyholeIcon}
                                    onClick={() => handleViewCredentials(connection.id)}
                                    tooltip="View credentials"
                                    loading={loadingCredentials[connection.id]}
                                  />
                                </Table.Td>
                              </Table.Tr>
                              {credentialsMap[connection.id] !== undefined && (
                                <Table.Tr>
                                  <Table.Td colSpan={5}>
                                    <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                      {JSON.stringify(credentialsMap[connection.id], null, 2)}
                                    </Code>
                                  </Table.Td>
                                </Table.Tr>
                              )}
                            </Fragment>
                          ))}
                        </Table.Tbody>
                      </Table>
                    ) : (
                      <Text13Book>No connections</Text13Book>
                    )}
                  </Stack>
                </Tabs.Panel>
              ))}
            </Tabs>
          )}
        </Stack>
      </Card.Section>
      <Card.Section p="xs" withBorder>
        <Stack>
          <Group gap="xs">
            <StyledLucideIcon Icon={LogsIcon} size={14} c="var(--fg-secondary)" />
            <TextTitle3>Audit Logs</TextTitle3>
          </Group>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Action</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {details.auditLogs.map((log) => (
                <Table.Tr key={log.id}>
                  <Table.Td>{new Date(log.createdAt).toLocaleString()}</Table.Td>
                  <Table.Td>{log.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </Card.Section>
    </Card>
  );
};

const SubscriptionInfo = ({ user }: { user: User }) => {
  const subscriptionBadge = () => {
    if (user.subscription?.status === 'valid') {
      return <BadgeOK>Active</BadgeOK>;
    } else if (user.subscription?.status === 'expired') {
      return <BadgeError>Expired</BadgeError>;
    } else {
      return <Badge>None</Badge>;
    }
  };

  return (
    <Group>
      {subscriptionBadge()}
      {user.subscription?.status === 'valid' && (
        <Text13Book>
          {user.subscription?.planDisplayName} - {user.subscription?.daysRemaining} days remaining
        </Text13Book>
      )}
    </Group>
  );
};
