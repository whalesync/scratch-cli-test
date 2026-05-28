/**
 * Phase → icon/label/color mapping used by the publish-history UI surfaces.
 * Lives here (not in a `.tsx` file) so it can be imported from anywhere
 * without tripping the `react-refresh/only-export-components` rule.
 */

import { CloudUploadIcon, FilePenLineIcon, MoveIcon, PlusCircleIcon, RepeatIcon, Trash2Icon } from 'lucide-react';

export interface PhaseMeta {
  Icon: typeof FilePenLineIcon;
  label: string;
  /** Mantine color name (use `var(--mantine-color-${color}-7)` for ink). */
  color: string;
}

export const PHASE_ICONS: Record<string, PhaseMeta> = {
  edit: { Icon: FilePenLineIcon, label: 'Edit', color: 'blue' },
  create: { Icon: PlusCircleIcon, label: 'Create', color: 'green' },
  delete: { Icon: Trash2Icon, label: 'Delete', color: 'red' },
  backfill: { Icon: RepeatIcon, label: 'Backfill', color: 'grape' },
  'asset-upload': { Icon: CloudUploadIcon, label: 'Asset upload', color: 'cyan' },
  'rename-files': { Icon: MoveIcon, label: 'Rename', color: 'orange' },
};
