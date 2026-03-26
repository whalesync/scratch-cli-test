'use client';

import { useConnectionMenu, type ConnectionMenuTarget } from '@/hooks/use-connection-menu';
import type { ConnectorAccount, WorkbookId } from '@spinner/shared-types';
import { ChooseTablesModal } from './ChooseTablesModal';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { RemoveConnectionModal } from './RemoveConnectionModal';
import { UpdateConnectionModal } from './UpdateConnectionModal';

export interface ConnectionContextMenuProps {
  connectorAccount: ConnectorAccount;
  workbookId: WorkbookId;
  /** When non-null the context menu is visible at this position. */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** Extra items to prepend (e.g. Pull All Tables) */
  extraItemsBefore?: ContextMenuItem[];
  /** Extra items after auth row, before divider (e.g. Show hidden files) */
  extraItemsAfter?: ContextMenuItem[];
  /** Called when reauthorization starts (for pulsing icon state) */
  onReauthorizeStart?: () => void;
  /** Called when reauthorization ends */
  onReauthorizeEnd?: () => void;
}

export function ConnectionContextMenu({
  connectorAccount,
  workbookId,
  position,
  onClose,
  extraItemsBefore,
  extraItemsAfter,
  onReauthorizeStart,
  onReauthorizeEnd,
}: ConnectionContextMenuProps) {
  const {
    items,
    modals,
    chooseTablesOpened,
    closeChooseTables,
    removeModalOpened,
    closeRemoveModal,
    updateConnectionModalOpened,
    closeUpdateConnectionModal,
  } = useConnectionMenu(workbookId, connectorAccount as ConnectionMenuTarget, {
    extraItemsBefore,
    extraItemsAfter,
    onReauthorizeStart,
    onReauthorizeEnd,
    fullConnectorAccount: connectorAccount,
  });

  return (
    <>
      {position && <ContextMenu opened={true} onClose={onClose} position={position} items={items} />}
      {modals}
      <ChooseTablesModal
        opened={chooseTablesOpened}
        onClose={closeChooseTables}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
      />
      <RemoveConnectionModal
        opened={removeModalOpened}
        onClose={closeRemoveModal}
        connectorAccount={connectorAccount}
        workbookId={workbookId}
      />
      <UpdateConnectionModal
        opened={updateConnectionModalOpened}
        onClose={closeUpdateConnectionModal}
        connectorAccount={connectorAccount}
      />
    </>
  );
}
