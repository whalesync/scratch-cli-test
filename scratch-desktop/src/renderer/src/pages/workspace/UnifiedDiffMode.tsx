import { ButtonSecondaryGhost } from '@/components/base/buttons';
import { GitCompare } from 'lucide-react';

/**
 * Experimental "Unified Diffs" view mode for FolderDataGrid. Canvas drawing lives in
 * unified-diff-cell.ts; this file only holds the toolbar toggle so Fast Refresh stays valid.
 * To remove the feature: delete this file, unified-diff-cell.ts, and references in FolderDataGrid.tsx.
 */

interface UnifiedDiffToggleButtonProps {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function UnifiedDiffToggleButton({ active, disabled, onToggle }: UnifiedDiffToggleButtonProps) {
  return (
    <ButtonSecondaryGhost
      size="compact-xs"
      leftSection={<GitCompare size={12} />}
      onClick={onToggle}
      disabled={disabled}
      c={active ? 'blue.8' : undefined}
    >
      Unified diffs
    </ButtonSecondaryGhost>
  );
}
