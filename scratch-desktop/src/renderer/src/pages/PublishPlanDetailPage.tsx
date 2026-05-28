import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspaceUiStore } from '../stores/workspace-ui-store';

/**
 * Thin deep-link landing for `/workspace/:id/publish-plan/:planId`. Sets the
 * panel state so the publish-history panel drills directly into the requested
 * plan, then redirects to the workspace root.
 */
export function PublishPlanDetailPage() {
  const { id, planId } = useParams<{ id: string; planId: string }>();
  const navigate = useNavigate();
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const setPublishHistoryDetailPlanId = useWorkspaceUiStore((s) => s.setPublishHistoryDetailPlanId);

  useEffect(() => {
    if (!id || !planId) return;
    setShowPublishHistoryPanel(true);
    setPublishHistoryDetailPlanId(planId);
    void navigate(`/workspace/${id}`, { replace: true });
  }, [id, planId, navigate, setShowPublishHistoryPanel, setPublishHistoryDetailPlanId]);

  return null;
}
