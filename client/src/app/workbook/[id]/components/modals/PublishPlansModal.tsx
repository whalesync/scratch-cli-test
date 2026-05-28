import { ModalWrapper } from '@/app/components/ModalWrapper';
import { Group, Title } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import { RocketIcon } from 'lucide-react';
import { PublishPlansList } from './PublishPlansList';

interface PublishPlansModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

export function PublishPlansModal({ opened, onClose, workbookId }: PublishPlansModalProps) {
  return (
    <ModalWrapper
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <RocketIcon size={20} />
          <Title order={4}>Publish Plans</Title>
        </Group>
      }
      size="90%"
      customProps={{ footer: null, noBodyPadding: true }}
    >
      <PublishPlansList workbookId={workbookId} enabled={opened} />
    </ModalWrapper>
  );
}
