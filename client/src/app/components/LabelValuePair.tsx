import { ActionIcon, Box, CopyButton, Group, Tooltip } from '@mantine/core';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { JSX, ReactNode } from 'react';
import { Text13Medium, Text13Regular } from './base/text';

export const LabelValuePair = ({
  label,
  value,
  canCopy,
  copyValue,
  minLabelWidth,
}: {
  label: ReactNode;
  value: ReactNode;
  canCopy?: boolean;
  copyValue?: string;
  minLabelWidth?: string | number;
}): JSX.Element => {
  return (
    <Group wrap="nowrap" align="start" gap="sm">
      <Text13Medium miw={minLabelWidth ?? '180px'}>{label}</Text13Medium>

      <Group gap={canCopy ? 'xs' : '0'}>
        {typeof value === 'string' ? (
          <Text13Regular style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {value}
          </Text13Regular>
        ) : (
          <Box>{value}</Box>
        )}

        {canCopy ? (
          <CopyButton value={copyValue ?? (typeof value === 'string' ? value : JSON.stringify(value))} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow position="right">
                <ActionIcon color={copied ? 'blue' : 'gray'} size="xs" variant="subtle" onClick={copy}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        ) : null}
      </Group>
    </Group>
  );
};
