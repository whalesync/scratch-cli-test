'use client';

import { Badge } from '@/app/components/base/badge';
import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useWorkspacePermissions } from '@/hooks/use-workspace-permissions';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { ActionIcon, Group, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import { Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useState } from 'react';

interface WorkspacePermissionsModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

export function WorkspacePermissionsModal({ opened, onClose, workbookId }: WorkspacePermissionsModalProps) {
  const { user } = useScratchPadUser();
  const { permissions, isLoading, addPermission, removePermission } = useWorkspacePermissions(
    opened ? workbookId : null,
  );
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
    try {
      await removePermission(permissionId);
    } catch (e) {
      notifications.show({
        title: 'Error',
        message: 'Failed to remove permission',
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
        <ButtonPrimarySolid
          leftSection={<StyledLucideIcon Icon={UserPlusIcon} size="sm" />}
          onClick={handleAdd}
          loading={isAdding}
        >
          Add User
        </ButtonPrimarySolid>
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
              permissions.map((p) => (
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
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      disabled={p.userId === user?.id}
                      onClick={() => handleRemove(p.id)}
                    >
                      <Trash2Icon size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      )}
    </ModalWrapper>
  );
}
