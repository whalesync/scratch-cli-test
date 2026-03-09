'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Medium, Text13Regular } from '@/app/components/base/text';
import { Group, Stack } from '@mantine/core';
import type { AiGenerateSyncResponse } from '@spinner/shared-types';
import { ArrowRight } from 'lucide-react';

interface AiSyncCreatedModalProps {
  opened: boolean;
  onClose: () => void;
  result: AiGenerateSyncResponse;
}

export function AiSyncCreatedModal({ opened, onClose, result }: AiSyncCreatedModalProps) {
  return (
    <ModalWrapper
      opened={opened}
      onClose={onClose}
      title={result.result === 'message' ? 'AI Response' : 'Sync Configuration Updated'}
      customProps={{
        footer: (
          <ButtonPrimarySolid onClick={onClose} fullWidth>
            Got it
          </ButtonPrimarySolid>
        ),
      }}
    >
      <Stack gap="sm" py="md">
        {result.summary && <Text13Regular mb="sm">{result.summary}</Text13Regular>}
        {result.result !== 'message' && (
          <>
            {result.tablePairings.length > 0 && (
              <Text13Regular c="dimmed">The following table pairings were configured:</Text13Regular>
            )}
            {result.tablePairings.map((pairing, i) => (
              <Group key={i} gap="sm" align="center">
                <ConnectorIcon connector={pairing.sourceConnectorService} size={20} />
                <Text13Medium>{pairing.sourceFolderName}</Text13Medium>
                <ArrowRight size={14} />
                <ConnectorIcon connector={pairing.destConnectorService} size={20} />
                <Text13Medium>{pairing.destFolderName}</Text13Medium>
              </Group>
            ))}
          </>
        )}
      </Stack>
    </ModalWrapper>
  );
}
