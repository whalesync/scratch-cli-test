import { ButtonPrimarySolid } from '@/components/base/buttons';
import { TextMono12Regular, TextTitle4 } from '@/components/base/text';
import { Box } from '@mantine/core';
import type { WorkspaceConnection } from '../../../types/local-files';
import { deriveConnectorDisplayNameForFolder, folderLeafName } from './derive-review-banner-context';

/**
 * The top context strip of the v2 review surface (design: `new-review-designs`): a yellow accent
 * bar + a two-line block — the Funnel Display title "Review before publishing to {connector} ·
 * {folder}" over a Geist-Mono "N pending · M approved" subtitle — with a primary "Discard all"
 * action on the right. The strip washes yellow (`#fffaf0`) while there are pending/approved changes
 * and falls back to the default panel background once there's nothing left to review.
 *
 * Purely presentational — the host supplies the counts (from `diffData.filterCounts`) and the
 * discard handler; the connector name is derived from the folder path's first segment against the
 * workspace connections.
 */
interface ReviewContextBannerProps {
  selectedFolderPath: string | null;
  /** Workspace connections (threaded from WorkspaceContent), used to name the connector. */
  connections: readonly WorkspaceConnection[];
  /** Folder-wide unreviewed count — `diffData.filterCounts.unreviewed`. */
  pendingCount: number;
  /** Folder-wide approved-but-unpublished count — `diffData.filterCounts.unpublished`. */
  approvedCount: number;
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

      <ButtonPrimarySolid size="compact-sm" disabled={discardDisabled} onClick={onDiscardAll} style={{ flexShrink: 0 }}>
        Discard all
      </ButtonPrimarySolid>
    </Box>
  );
}
