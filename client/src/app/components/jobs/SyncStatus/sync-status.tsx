import { FC } from 'react';
import { TableIndicator } from './components/base-avatar-with-indicator';

import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { formatNumber } from '@/utils/helpers';
import { ActionIcon, Text } from '@mantine/core';
import { Service } from '@spinner/shared-types';
import { ArrowRightIcon } from 'lucide-react';
import { ConnectorIcon } from '../../Icons/ConnectorIcon';
import { StyledLucideIcon } from '../../Icons/StyledLucideIcon';
import { getStatusColor, getStatusText } from '../job-utils';
import { TableStatus } from '../publish/PublishJobProgress';
import { SyncDirectedFlowLine } from './components/sync-direction-flow-line';
import { SyncStatusLayout } from './layout/sync-status-layout';

// This component instantiates and passes the SyncStatus micro components to the SyncStatusLayout slots.

type Props = {
  tableName: string;
  connector: string;
  doneCount: number;
  totalCount?: number;
  status: TableStatus;
  direction?: 'left' | 'right';
};

const getBadgeColor = (status: TableStatus) => {
  switch (status) {
    case 'in_progress':
      return { fg: 'blue', bg: 'blue' };
    case 'completed':
      return { fg: 'var(--fg-accept)', bg: 'var(--bg-accept)' };
    case 'failed':
      return { fg: 'var(--fg-reject)', bg: 'var(--bg-reject)' };
    case 'canceled':
      return { fg: 'yellow', bg: 'yellow' };
    case 'pending':
    default:
      return { fg: 'gray', bg: 'gray' };
  }
};

export const SyncStatus: FC<Props> = (props) => {
  const { metadata } = useConnectorsMetadata();
  const { tableName, connector, doneCount, totalCount, status, direction = 'right' } = props;
  const badgeColor = getBadgeColor(status);
  const isMoving = status === 'in_progress';
  const maxCharacters = 20;
  const truncatedTableName =
    tableName.length > maxCharacters ? `${tableName.slice(0, maxCharacters - 3)}...` : tableName;

  return (
    <SyncStatusLayout
      // Top slots
      leftIcon={direction === 'right' ? <TableIndicator /> : <ConnectorIcon connector={connector} />}
      leftFlowLine={<SyncDirectedFlowLine direction={'right'} moving={isMoving} />}
      centerIcon={
        <ActionIcon size="lg" radius="xl" variant="filled" color={badgeColor.fg}>
          <StyledLucideIcon Icon={ArrowRightIcon} size="md" />
        </ActionIcon>
      }
      rightFlowLine={<SyncDirectedFlowLine direction={'right'} moving={isMoving} />}
      rightIcon={direction === 'left' ? <TableIndicator /> : <ConnectorIcon connector={connector} />}
      // Bottom slots
      bottomLeftSlot={<>{truncatedTableName}</>}
      bottomCenterSlot={
        <Text c={getStatusColor(status)} fw={500}>
          {getStatusText(status)}
        </Text>
      }
      bottomRightSlot={<>{getServiceName(metadata, connector as Service)}</>}
      thirdRowCenter={
        <Text c="var(--fg-muted)" fw={500}>
          {direction === 'left'
            ? `${formatNumber(doneCount)} records downloaded`
            : `${formatNumber(doneCount)} out of ${formatNumber(totalCount ?? 0)} records pushed`}
        </Text>
      }
    />
  );
};
