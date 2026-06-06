import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeChatAvailability, ClaudeChatEvent } from '../../../shared/claude-chat';
import { trackSendClaudeChatMessage } from '../lib/posthog';

/** A tool Claude invoked during a turn, reduced to a display label by the main process. */
export interface ClaudeChatToolUseItem {
  toolUseId: string;
  label: string;
}

export interface ClaudeChatMessage {
  /** For assistant messages this equals the turn's `requestId`. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Tools the assistant used this turn (assistant messages only). */
  tools: ClaudeChatToolUseItem[];
  status: 'streaming' | 'complete' | 'error';
  errorText?: string;
}

export interface UseClaudeChatResult {
  messages: ClaudeChatMessage[];
  isStreaming: boolean;
  model: string | null;
  /** `null` while the availability probe is in flight. */
  availability: ClaudeChatAvailability | null;
  sendMessage: (text: string) => void;
  stop: () => void;
  newChat: () => void;
}

/**
 * Drives one workspace's embedded Claude chat. Owns the message list, mints a
 * `requestId` per turn, and folds the normalized `ClaudeChatEvent` stream from
 * the main process into the in-flight assistant message.
 *
 * Conversation state is in-memory for the life of the panel (persistence is a
 * deferred fast-follow per the design doc). On unmount — panel close or
 * workspace switch — any in-flight turn is SIGTERM'd so no `claude` child is
 * orphaned.
 *
 * `workspaceId` is the workbook id, used only for analytics — we never send the
 * local `workspacePath` (it contains the user's home directory) to PostHog.
 */
export function useClaudeChat(workspacePath: string | null, workspaceId: string): UseClaudeChatResult {
  const [messages, setMessages] = useState<ClaudeChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [availability, setAvailability] = useState<ClaudeChatAvailability | null>(null);

  /** The requestId of the turn currently streaming, or null when idle. */
  const activeRequestIdRef = useRef<string | null>(null);

  // Probe for the BYO `claude` CLI once per workspace.
  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    void window.scratchDesktop.checkClaudeChatAvailable().then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  // Subscribe to the normalized event stream. Filters by the active requestId so
  // a late event from a stopped turn can never mutate a newer one.
  useEffect(() => {
    const unsubscribe = window.scratchDesktop.onClaudeChatEvent((event: ClaudeChatEvent) => {
      if (event.requestId !== activeRequestIdRef.current) {
        return;
      }

      if (event.type === 'session') {
        setModel(event.model);
        return;
      }

      if (event.type === 'exit') {
        activeRequestIdRef.current = null;
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === event.requestId && message.status === 'streaming'
              ? { ...message, status: 'complete' }
              : message,
          ),
        );
        return;
      }

      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== event.requestId) {
            return message;
          }
          switch (event.type) {
            case 'assistant_text_delta':
              return { ...message, text: message.text + event.text };
            case 'tool_use':
              if (message.tools.some((tool) => tool.toolUseId === event.toolUse.toolUseId)) {
                return message;
              }
              return {
                ...message,
                tools: [...message.tools, { toolUseId: event.toolUse.toolUseId, label: event.toolUse.label }],
              };
            case 'result':
              if (event.isError) {
                return {
                  ...message,
                  status: 'error',
                  errorText: event.resultText ?? 'Claude could not finish this request.',
                };
              }
              // Cover the rare no-delta turn (e.g. tools only) by falling back to
              // the final result text when nothing streamed.
              return message.text ? message : { ...message, text: event.resultText ?? message.text };
            case 'error':
              return { ...message, status: 'error', errorText: event.message };
            default:
              return message;
          }
        }),
      );
    });
    return unsubscribe;
  }, []);

  // Reset everything when the workspace changes, and SIGTERM any in-flight turn
  // when the hook unmounts (panel close / workspace switch).
  useEffect(() => {
    setMessages([]);
    setModel(null);
    setIsStreaming(false);
    activeRequestIdRef.current = null;
    return () => {
      const inFlightRequestId = activeRequestIdRef.current;
      if (inFlightRequestId) {
        void window.scratchDesktop.stopClaudeChat(inFlightRequestId);
        activeRequestIdRef.current = null;
      }
    };
  }, [workspacePath]);

  const sendMessage = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      if (!workspacePath || !text || activeRequestIdRef.current) {
        return;
      }
      const requestId = crypto.randomUUID();
      activeRequestIdRef.current = requestId;
      setIsStreaming(true);
      setMessages((prev) => [
        ...prev,
        { id: `user-${requestId}`, role: 'user', text, tools: [], status: 'complete' },
        { id: requestId, role: 'assistant', text: '', tools: [], status: 'streaming' },
      ]);
      void trackSendClaudeChatMessage(workspaceId, text.length);

      void window.scratchDesktop.sendClaudeChatMessage(workspacePath, text, requestId).catch((error: unknown) => {
        if (activeRequestIdRef.current !== requestId) {
          return;
        }
        activeRequestIdRef.current = null;
        setIsStreaming(false);
        const messageText = error instanceof Error ? error.message : 'Could not start Claude.';
        setMessages((prev) =>
          prev.map((message) =>
            message.id === requestId ? { ...message, status: 'error', errorText: messageText } : message,
          ),
        );
      });
    },
    [workspacePath, workspaceId],
  );

  const stop = useCallback(() => {
    const inFlightRequestId = activeRequestIdRef.current;
    if (!inFlightRequestId) {
      return;
    }
    void window.scratchDesktop.stopClaudeChat(inFlightRequestId);
    activeRequestIdRef.current = null;
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((message) =>
        message.id === inFlightRequestId && message.status === 'streaming'
          ? { ...message, status: 'complete' }
          : message,
      ),
    );
  }, []);

  const newChat = useCallback(() => {
    const inFlightRequestId = activeRequestIdRef.current;
    if (inFlightRequestId) {
      void window.scratchDesktop.stopClaudeChat(inFlightRequestId);
      activeRequestIdRef.current = null;
    }
    if (workspacePath) {
      void window.scratchDesktop.resetClaudeChatSession(workspacePath);
    }
    setMessages([]);
    setModel(null);
    setIsStreaming(false);
  }, [workspacePath]);

  return { messages, isStreaming, model, availability, sendMessage, stop, newChat };
}
