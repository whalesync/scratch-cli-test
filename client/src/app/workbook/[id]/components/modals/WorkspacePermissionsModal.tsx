'use client';

import { Badge } from '@/app/components/base/badge';
import { ButtonPrimarySolid, DevToolButtonGhost } from '@/app/components/base/buttons';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useWorkbook } from '@/hooks/use-workbook';
import { useWorkspacePermissions } from '@/hooks/use-workspace-permissions';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { ActionIcon, Group, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkbookId, WorkspaceInviteId, WorkspacePermissionId } from '@spinner/shared-types';
import { Trash2Icon, UserPlusIcon, UserRoundXIcon, UserStar } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface WorkspacePermissionsModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

export function WorkspacePermissionsModal({ opened, onClose, workbookId }: WorkspacePermissionsModalProps) {
  const router = useRouter();
  const { user } = useScratchPadUser();
  const { isDevToolsEnabled } = useDevTools();
  const { workbook } = useWorkbook(opened ? workbookId : null);
  const { permissions, invites, isLoading, addPermission, removePermission, removeInvite } = useWorkspacePermissions(
    opened ? workbookId : null,
  );
  const [email, setEmail] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isAddingSelf, setIsAddingSelf] = useState(false);

  // Admin-only convenience: admins already have implicit access to every workbook
  // server-side, so this lets them grant themselves an explicit permission row in
  // one click (e.g. when debugging a user's workspace) instead of typing their own
  // email. Hidden once they already appear in the list to avoid duplicate rows.
  const currentUserAlreadyHasPermission = permissions.some((p) => p.userId === user?.id);
  const canAddSelfAsAdmin = Boolean(
    isDevToolsEnabled && user?.isAdmin && user?.email && !currentUserAlreadyHasPermission,
  );

  const handleAddSelf = async () => {
    if (!user?.email) return;
    setIsAddingSelf(true);
    try {
      await addPermission({ email: user.email, role: 'editor' });
    } catch (e) {
      notifications.show({
        title: 'Error',
        message: 'Failed to add yourself to the workspace',
        color: 'red',
      });
      console.error(e);
    } finally {
      setIsAddingSelf(false);
    }
  };

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
      console.error(e);
      return;
    }
    // After removing your own access you can no longer view this workbook, so leave
    // it for the workbooks list.
    if (removedPermissionBelongsToCurrentUser) {
      onClose();
      router.push('/workbook');
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
      console.error(e);
    }
  };

  return (
    <ModalWrapper
      opened={opened}
      onClose={onClose}
      title="Workspace Permissions"
      size="lg"
      customProps={{ footer: null, noBodyPadding: true }}
    >
      <Group mb="md" align="flex-start" px="md" pt="md">
        <TextInput
          placeholder="user@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.currentTarget.value);
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          error={addError}
          style={{ flex: 1 }}
        />
        <Stack>
          <ButtonPrimarySolid
            leftSection={<StyledLucideIcon Icon={UserPlusIcon} size="sm" />}
            onClick={handleAdd}
            loading={isAdding}
          >
            Add User
          </ButtonPrimarySolid>
          {canAddSelfAsAdmin && (
            <DevToolButtonGhost size="xs" onClick={handleAddSelf} loading={isAddingSelf} leftSection={<UserStar />}>
              Add Me
            </DevToolButtonGhost>
          )}
        </Stack>
      </Group>

      {isLoading ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          Loading...
        </Text>
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
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    No permissions.
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              permissions.map((p) => {
                const isWorkspaceCreatorOwner = p.userId === workbook?.userId;
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
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    disabled={removeIsDisabled}
                    onClick={() => handleRemove(p.id)}
                  >
                    <UserRoundXIcon size={14} />
                  </ActionIcon>
                );
                return (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="xs">{p.userName}</Text>
                        {p.isAdmin && <Badge color="black">Admin</Badge>}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {p.userEmail}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{p.role}</Text>
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
        <>
          <Text size="sm" fw={600} px="md" pt="md" pb="xs">
            Pending Invites
          </Text>
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
                    <Text size="xs" c="dimmed">
                      {new Date(invite.createdAt).toLocaleDateString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {invite.email}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{invite.role}</Text>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => handleRemoveInvite(invite.id)}>
                      <Trash2Icon size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </ModalWrapper>
  );
}
