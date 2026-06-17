import { ButtonPrimarySolid, IconButtonGhost } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular, TextMono12Regular, TextTitle4 } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useWorkspace } from '@/hooks/use-workspace';
import { useWorkspacePermissions } from '@/hooks/use-workspace-permissions';
import { Badge, Group, Stack, Table, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkspaceInviteId, WorkspacePermissionId } from '@spinner/shared-types';
import { Trash2Icon, UserPlusIcon, UserRoundXIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface WorkspacePermissionsSettingsProps {
  workbookId: string;
}

export function WorkspacePermissionsSettings({ workbookId }: WorkspacePermissionsSettingsProps) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { workspace } = useWorkspace(workbookId);
  const { permissions, invites, isLoading, addPermission, removePermission, removeInvite } =
    useWorkspacePermissions(workbookId);
  const [email, setEmail] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setAddError(null);
    setIsAdding(true);
    try {
      await addPermission({ email: trimmed, role: 'editor' });
      setEmail('');
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : typeof e === 'string' ? e : `Failed to add permission for ${trimmed}`;
      setAddError(message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemove = async (permissionId: WorkspacePermissionId) => {
    const removedPermissionBelongsToCurrentUser = permissions.find((p) => p.id === permissionId)?.userId === user?.id;
    try {
      await removePermission(permissionId);
    } catch (e) {
      notifications.show({
        title: 'Error',
        message: 'Failed to remove permission',
        color: 'red',
      });
      console.debug(e);
      return;
    }
    // After removing your own access you can no longer view this workspace, so leave
    // it for the home page workspace listings.
    if (removedPermissionBelongsToCurrentUser) {
      void navigate('/');
    }
  };

  const handleRemoveInvite = async (inviteId: WorkspaceInviteId) => {
    try {
      await removeInvite(inviteId);
    } catch (e) {
      notifications.show({
        title: 'Error',
        message: 'Failed to remove invite',
        color: 'red',
      });
      console.debug(e);
    }
  };

  return (
    <Stack gap="md" px="md">
      <TextTitle4>Workspace Permissions</TextTitle4>
      <Group align="flex-start" gap="sm">
        <TextInput
          placeholder="user@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.currentTarget.value);
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd();
          }}
          error={addError}
          style={{ flex: 1 }}
        />
        <ButtonPrimarySolid
          leftSection={<StyledLucideIcon Icon={UserPlusIcon} size="sm" />}
          onClick={() => void handleAdd()}
          loading={isAdding}
        >
          Add User
        </ButtonPrimarySolid>
      </Group>

      {isLoading ? (
        <Text13Regular c="dimmed" ta="center" py="md">
          Loading...
        </Text13Regular>
      ) : (
        <Table stickyHeader highlightOnHover horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Email</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th w={60} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {permissions.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={4}>
                  <Text13Regular c="dimmed" ta="center" py="md">
                    No permissions.
                  </Text13Regular>
                </Table.Td>
              </Table.Tr>
            ) : (
              permissions.map((p) => {
                const isWorkspaceCreatorOwner = p.userId === workspace?.userId;
                const isCurrentUsersOwnPermission = p.userId === user?.id;
                const isOnlyUserWithAccess = permissions.length === 1;
                // The workspace owner can never be removed (by anyone), and you can't
                // remove yourself if you're the only user with access.
                const removeIsDisabled =
                  isWorkspaceCreatorOwner || (isCurrentUsersOwnPermission && isOnlyUserWithAccess);
                const disabledTooltipLabel = isWorkspaceCreatorOwner
                  ? "You can't remove the workspace owner"
                  : "You can't remove the only user with access";
                const removeButton = (
                  <IconButtonGhost
                    disabled={removeIsDisabled}
                    onClick={() => void handleRemove(p.id)}
                    aria-label={`Remove ${p.userName}`}
                  >
                    <StyledLucideIcon Icon={UserRoundXIcon} size="sm" c="var(--mantine-color-red-6)" />
                  </IconButtonGhost>
                );
                return (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text12Regular>{p.userName}</Text12Regular>
                        {p.isAdmin && (
                          <Badge size="sm" radius="sm" variant="light" color="gray">
                            Admin
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <TextMono12Regular>{p.userEmail}</TextMono12Regular>
                    </Table.Td>
                    <Table.Td>
                      <Text12Regular>{p.role}</Text12Regular>
                    </Table.Td>
                    <Table.Td>
                      {removeIsDisabled ? (
                        <Tooltip label={disabledTooltipLabel}>
                          <span>{removeButton}</span>
                        </Tooltip>
                      ) : (
                        removeButton
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })
            )}
          </Table.Tbody>
        </Table>
      )}

      {!isLoading && invites.length > 0 && (
        <Stack gap="xs">
          <Text13Medium>Pending Invites</Text13Medium>
          <Table stickyHeader highlightOnHover horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Sent</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {invites.map((invite) => (
                <Table.Tr key={invite.id}>
                  <Table.Td>
                    <Text12Regular c="dimmed">{new Date(invite.createdAt).toLocaleDateString()}</Text12Regular>
                  </Table.Td>
                  <Table.Td>
                    <TextMono12Regular>{invite.email}</TextMono12Regular>
                  </Table.Td>
                  <Table.Td>
                    <Text12Regular>{invite.role}</Text12Regular>
                  </Table.Td>
                  <Table.Td>
                    <IconButtonGhost
                      onClick={() => void handleRemoveInvite(invite.id)}
                      aria-label={`Remove invite for ${invite.email}`}
                    >
                      <StyledLucideIcon Icon={Trash2Icon} size="sm" c="var(--mantine-color-red-6)" />
                    </IconButtonGhost>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}
    </Stack>
  );
}
