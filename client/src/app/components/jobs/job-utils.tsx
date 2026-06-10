import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Job } from '@spinner/shared-types';
import { CheckIcon, CircleIcon, CircleXIcon, DotIcon } from 'lucide-react';
import { TableStatus } from './publish/PublishJobProgress';

/**
 * Map non-terminal table statuses in a job in a terminal status to terminal table statuses
 * When a job terminates the individual table statuses are not updated.
 * So in a case of a stall for example the table that is in_progress remains in_progress
 * It is easier to leave progress untuched but to update the statuses when presenting to the user.
 * So an in_progress table in a failed job is considered failed.
 *
 */
export const getTerminalTableStatus = (tableStatus: TableStatus, jobStatus: Job['state'] | undefined): TableStatus => {
  // If the job is in a non-active terminal state (canceled or failed),
  // pending and in-progress tables are effectively canceled/stopped.
  const isJobStopped = jobStatus === 'canceled' || jobStatus === 'failed';

  if (isJobStopped) {
    if (tableStatus === 'in_progress') {
      return jobStatus;
    }
    if (tableStatus === 'pending') {
      return 'canceled';
    }
  }

  return tableStatus;
};

export const getStatusText = (status: TableStatus) => {
  switch (status) {
    case 'in_progress':
      return 'Publishing...';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    case 'pending':
    default:
      return 'Pending';
  }
};

export const getStatusColor = (status: TableStatus) => {
  switch (status) {
    case 'in_progress':
      return 'blue';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'pending':
    default:
      return 'gray';
  }
};

export const getTableIndicator = (status: TableStatus) => {
  switch (status) {
    case 'pending':
      return <StyledLucideIcon Icon={CircleIcon} size={12} c="gray" />;
    case 'in_progress':
      return <StyledLucideIcon Icon={DotIcon} size={12} c="blue" />;
    case 'completed':
      return <StyledLucideIcon Icon={CheckIcon} size={12} c="green" />;
    case 'failed':
      return <StyledLucideIcon Icon={CircleIcon} size={12} c="red" />;
    case 'canceled':
      return <StyledLucideIcon Icon={CircleXIcon} size={12} c="yellow" />;
    default:
      return <StyledLucideIcon Icon={CircleIcon} size={12} c="gray" />;
  }
};
