/**
 * Shared types + channel constants for the embedded Claude chat panel
 * (Approach A — "thin CLI shell-out panel" from
 * docs/plans/2026-06-05-chat-with-claude-in-desktop.md).
 *
 * The main process spawns the `claude` CLI in headless streaming mode
 * (`-p --output-format stream-json --verbose --include-partial-messages`) with
 * `cwd` = the local workbook checkout, parses the stream-json events, and
 * forwards a NORMALIZED, connector-agnostic event stream to the renderer over
 * the `CLAUDE_CHAT_EVENT_CHANNEL`. The renderer never sees the raw stream-json
 * (and therefore never has to know about the CLI's event shapes).
 *
 * Edits Claude makes to record files land on disk and are surfaced through the
 * existing `WorkspaceFileWatchService` → change-review view as EXTERNAL
 * mutations (the agent's writes are deliberately NOT wrapped in
 * `beginInternalWorkspaceMutation`), so they flow through the
 * published→approved→local review ladder unchanged.
 */

/** main → renderer: one normalized chat event. */
export const CLAUDE_CHAT_EVENT_CHANNEL = 'scratch:claude-chat-event';

/**
 * A single tool invocation Claude made during a turn, reduced to a
 * human-friendly one-line label computed in the main process (e.g.
 * "Edited HubSpot/Posts/123.json", "$ git status"). The renderer renders the
 * label verbatim and stays free of any tool/connector-specific knowledge.
 */
export interface ClaudeChatToolUse {
  toolUseId: string;
  toolName: string;
  label: string;
}

/**
 * Normalized event forwarded to the renderer. Every variant carries the
 * `requestId` of the turn it belongs to so the renderer can match it to the
 * in-flight message it started (multiple turns never overlap per workspace,
 * but the id keeps the contract unambiguous and survives the IPC boundary).
 */
export type ClaudeChatEvent =
  | { requestId: string; type: 'session'; sessionId: string; model: string }
  | { requestId: string; type: 'assistant_text_delta'; text: string }
  | { requestId: string; type: 'tool_use'; toolUse: ClaudeChatToolUse }
  | { requestId: string; type: 'result'; isError: boolean; resultText: string | null }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'exit'; exitCode: number };

/** Result of probing for the `claude` CLI on the user's machine (BYO auth). */
export interface ClaudeChatAvailability {
  available: boolean;
  /** Absolute path to the resolved binary, when found. */
  binaryPath: string | null;
}

/** Returned by the "send a message" IPC so the renderer can correlate events. */
export interface StartClaudeChatTurnResult {
  requestId: string;
  /** True when this turn resumed an existing session, false when it started one. */
  resumedExistingSession: boolean;
}
