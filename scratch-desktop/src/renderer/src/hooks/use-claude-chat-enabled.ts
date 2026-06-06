import { useCallback, useState } from 'react';

const LOCAL_STORAGE_KEY = 'claude_chat_enabled';

function readClaudeChatEnabled(): boolean {
  try {
    return localStorage.getItem(LOCAL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Dev-only feature flag for the embedded Claude chat tab. Off by default and
 * toggled from the workspace Debug menu (which itself only appears for users
 * with the dev toolbox), so the chat tab is effectively dev-only until the
 * feature is ready for everyone. Persisted in localStorage so it survives
 * restarts; backed by `useState` so toggling it re-renders the workspace.
 */
export function useClaudeChatEnabled(): { claudeChatEnabled: boolean; toggleClaudeChatEnabled: () => void } {
  const [claudeChatEnabled, setClaudeChatEnabled] = useState<boolean>(readClaudeChatEnabled);

  const toggleClaudeChatEnabled = useCallback(() => {
    setClaudeChatEnabled((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, String(next));
      } catch {
        // Persistence failed — keep the in-memory flip for this session.
      }
      return next;
    });
  }, []);

  return { claudeChatEnabled, toggleClaudeChatEnabled };
}
