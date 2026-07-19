import { ButtonPrimarySolid, IconButtonGhost } from '@/components/base/buttons';
import { TextMono12Regular, TextTitle4 } from '@/components/base/text';
import { Box } from '@mantine/core';
import { EllipsisVertical } from 'lucide-react';
import type { WorkspaceConnection } from '../../../types/local-files';
import { deriveConnectorDisplayNameForFolder, folderLeafName } from './derive-review-banner-context';

/**
 * The top context strip of the v2 review surface (design: `new-review-designs`): a yellow accent
 * bar + a two-line block — the Funnel Display title "Review before publishing to {connector} ·
 * {folder}" over a Geist-Mono "N pending · M approved" subtitle. The right side leads with the
 * primary "Approve all" action; the uncommon, destructive "Discard all" lives in a kebab (`⋮`)
 * overflow menu beside it. The strip washes yellow (`#fffaf0`) while there are pending/approved
 * changes and falls back to the default panel background once there's nothing left to review.
 *
 * Purely presentational — the host supplies the counts (from `diffData.filterCounts`) and the
 * approve/discard handlers; the connector name is derived from the folder path's first segment
 * against the workspace connections.
 */
interface ReviewContextBannerProps {
  selectedFolderPath: string | null;
  /** Workspace connections (threaded from WorkspaceContent), used to name the connector. */
  connections: readonly WorkspaceConnection[];
  /** Folder-wide unreviewed count — `diffData.filterCounts.unreviewed`. */
  pendingCount: number;
  /** Folder-wide approved-but-unpublished count — `diffData.filterCounts.unpublished`. */
  approvedCount: number;
  /** Primary action: approve every pending change in the folder. */
  onApproveAll: () => void;
  /** Disabled when there's nothing pending to approve or a bulk action is already running. */
  approveDisabled: boolean;
  onDiscardAll: () => void;
  /** Disabled when there's nothing to discard or a bulk action is already running. */
  discardDisabled: boolean;
}

// Design banner colors (fixed literals from `new-review-designs`); no semantic token exists yet. The
// yellow wash is a fixed light color, so its text must also be fixed-dark — using the theme-adaptive
// `--fg-primary` there would render invisible (light-on-light) in dark mode.
const BANNER_YELLOW_BG = '#fffaf0';
const BANNER_YELLOW_BORDER = '#f0e6cf';
const BANNER_YELLOW_TITLE = '#212529';
const BANNER_SUBTITLE_GOLD = '#9a7b00';

export function ReviewContextBanner({
  selectedFolderPath,
  connections,
  pendingCount,
  approvedCount,
  onApproveAll,
  approveDisabled,
  onDiscardAll,
  discardDisabled,
}: ReviewContextBannerProps) {
  const connectorName = deriveConnectorDisplayNameForFolder(selectedFolderPath, connections);
  const folderName = folderLeafName(selectedFolderPath);

  let title = 'Review before publishing';
  if (connectorName && folderName) title += ` to ${connectorName} · ${folderName}`;
  else if (connectorName) title += ` to ${connectorName}`;
  else if (folderName) title += ` to ${folderName}`;

  // Wash yellow while there's something to review; fall back to the panel background otherwise.
  const hasChanges = pendingCount + approvedCount > 0;

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        backgroundColor: hasChanges ? BANNER_YELLOW_BG : 'var(--bg-panel)',
        borderBottom: `0.5px solid ${hasChanges ? BANNER_YELLOW_BORDER : 'var(--fg-divider)'}`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'stretch', gap: 10, minWidth: 0 }}>
        {/* The yellow accent bar only shows while there's something to review. */}
        {hasChanges && (
          <Box
            style={{
              width: 6,
              borderRadius: 2,
              backgroundColor: 'var(--highlight-fill)',
              border: '1px solid var(--highlight-border)',
              flexShrink: 0,
            }}
          />
        )}
        <Box style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, minWidth: 0 }}>
          <TextTitle4
            fz="15px"
            fw={600}
            c={hasChanges ? BANNER_YELLOW_TITLE : 'var(--fg-primary)'}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {title}
          </TextTitle4>
          <TextMono12Regular fz="11px" c={hasChanges ? BANNER_SUBTITLE_GOLD : 'var(--fg-muted)'}>
            {pendingCount.toLocaleString()} needs review · {approvedCount.toLocaleString()} approved
          </TextMono12Regular>
        </Box>
      </Box>

      <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <ButtonPrimarySolid size="compact-sm" disabled={approveDisabled} onClick={onApproveAll}>
          Approve all
        </ButtonPrimarySolid>
        {/* Uncommon, destructive bulk actions live behind a kebab so "Approve all" stays the sole
            primary CTA. Native menu per the desktop convention (never a Mantine dropdown). The
            foreground is pinned to the fixed-dark banner title color while the strip is washed
            yellow, since the theme-adaptive ghost foreground would vanish (light-on-light) in dark
            mode. When there's nothing to discard the whole kebab is disabled, so the menu never
            opens onto a lone greyed-out item. */}
        <IconButtonGhost
          size="compact-sm"
          aria-label="More review actions"
          disabled={discardDisabled}
          c={hasChanges ? BANNER_YELLOW_TITLE : undefined}
          onClick={() =>
            window.scratchDesktop.showNativeContextMenu([{ id: 'discard-all', label: 'Discard all' }], (id) => {
              if (id === 'discard-all') onDiscardAll();
            })
          }
        >
          <EllipsisVertical size={14} />
        </IconButtonGhost>
      </Box>
    </Box>
  );
}
