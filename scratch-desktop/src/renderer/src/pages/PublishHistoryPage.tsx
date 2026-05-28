import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspaceUiStore } from '../stores/workspace-ui-store';

/**
 * Thin deep-link landing for `/workspace/:id/publish-history`. The actual UI
 * lives inside `PublishHistoryPanel`, which is rendered by `WorkspaceContent`
 * when the panel is open. This route just toggles the panel on and redirects
 * to the workspace root so the URL stays clean.
 */
export function PublishHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const setPublishHistoryDetailPlanId = useWorkspaceUiStore((s) => s.setPublishHistoryDetailPlanId);

  useEffect(() => {
    if (!id) return;
    setPublishHistoryDetailPlanId(null);
    setShowPublishHistoryPanel(true);
    void navigate(`/workspace/${id}`, { replace: true });
  }, [id, navigate, setShowPublishHistoryPanel, setPublishHistoryDetailPlanId]);

  return null;
}
