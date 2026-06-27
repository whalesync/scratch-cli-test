// Faithful reproduction of the desktop app's Publish modal — the review/approval stage shown before
// publishing: validation + unreviewed-edit notices, and the all-or-nothing accept/discard choice.
// Self-contained; no IPC. Reproduced from the real PublishChangesModal source (DEV-10592).
import { Box, Group, Stack } from '@mantine/core';
import { ButtonDangerLight, ButtonPrimarySolid, ButtonSecondaryOutline } from '../../buttons';
import { Text13Regular } from '../../text';
import { ModalShell } from './modal-shell';

export function PublishReviewModal() {
  return (
    <ModalShell title="Publish changes" width={560}>
      <Stack gap={16}>
        <Text13Regular c="var(--mantine-color-red-6)">
          4 records contain validation errors that may prevent them from publishing.
        </Text13Regular>
        <Box>
          <Text13Regular c="var(--fg-primary)">8 records contain unreviewed local edits.</Text13Regular>
          <Text13Regular c="var(--fg-muted)" style={{ marginTop: 4 }}>
            Publishing is blocked until you decide what to do with these edits. Accept them to publish the new values,
            or discard them to revert to the last accepted state.
          </Text13Regular>
        </Box>
        <Group justify="flex-end" gap={10} wrap="nowrap">
          <ButtonSecondaryOutline>Cancel</ButtonSecondaryOutline>
          <ButtonDangerLight>Discard and publish</ButtonDangerLight>
          <ButtonPrimarySolid>Accept and publish</ButtonPrimarySolid>
        </Group>
      </Stack>
    </ModalShell>
  );
}
