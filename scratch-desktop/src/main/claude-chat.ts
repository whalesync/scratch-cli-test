/**
 * Embedded Claude chat — main-process service (Approach A from
 * docs/plans/2026-06-05-chat-with-claude-in-desktop.md).
 *
 * Per user message, spawns the `claude` CLI in headless streaming mode with
 * `cwd` = the local workbook checkout, parses its `stream-json` event stream,
 * and forwards a normalized, connector-agnostic event stream to the renderer.
 * Modeled on `scratchmd.ts`'s spawn + IPC streaming and child-teardown pattern.
 *
 * Three things this service is deliberately careful about (all from the plan's
 * landmine list):
 *   1. **Non-TTY streaming** — we use `--print --output-format stream-json
 *      --verbose --include-partial-messages` and parse JSON events line-by-line.
 *      We never scrape terminal text (a raw pipe makes `claude` buffer/hang).
 *   2. **Session continuity** — the first turn for a workspace mints a UUID and
 *      passes `--session-id`; later turns pass `--resume <id>` so the chat is
 *      multi-turn. The id is kept in-memory per workspace path (cleared on
 *      "New chat" / app restart).
 *   3. **Process lifecycle** — every spawned child is tracked and SIGTERM'd on
 *      window-close / workbook-switch / explicit stop, so an orphaned agent can
 *      never keep mutating the git repo.
 *
 * Agent file edits are intentionally treated as EXTERNAL mutations — we do NOT
 * wrap the spawn in `beginInternalWorkspaceMutation`. That is what lets the
 * `WorkspaceFileWatchService` surface Claude's edits in the change-review view,
 * where they move through the published→approved→local ladder (nothing
 * auto-publishes — the ladder, not a permission prompt, is the guardrail).
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { WebContents } from 'electron';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative } from 'path';
import {
  CLAUDE_CHAT_EVENT_CHANNEL,
  type ClaudeChatAvailability,
  type ClaudeChatEvent,
  type StartClaudeChatTurnResult,
} from '../shared/claude-chat';

interface ActiveTurn {
  requestId: string;
  child: ChildProcess;
  webContentsId: number;
  workspacePath: string;
}

interface TurnParseState {
  sawResult: boolean;
}

const TOOL_LABEL_MAX_LENGTH = 80;
const TOOL_PATTERN_MAX_LENGTH = 60;
/** Keep only the tail of stderr — surfaced as the error message if the child dies before a result. */
const STDERR_TAIL_MAX_LENGTH = 2000;

/**
 * Resolve the absolute path to the user's `claude` binary (BYO auth — we never
 * bundle it). A packaged Electron app on macOS does NOT inherit the user's
 * shell `PATH`, so a bare `spawn('claude')` would `ENOENT`; we probe the well-
 * known install locations instead (and honor an explicit override for QA).
 */
export function resolveClaudeBinaryPath(): string | null {
  const explicitOverride = process.env.SCRATCH_CLAUDE_CLI_PATH;
  if (explicitOverride && existsSync(explicitOverride)) {
    return explicitOverride;
  }
  const home = homedir();
  const candidateBinaryPaths = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const candidate of candidateBinaryPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Collapse whitespace and clip to `maxLength` so tool labels stay one line. */
function truncateForLabel(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

/**
 * Turn an absolute file path into a short, workspace-relative POSIX path for
 * display. Paths outside the workspace collapse to their filename so a label
 * never leaks the user's home directory.
 */
function toWorkspaceRelativePathForDisplay(absoluteFilePath: string, workspacePath: string): string {
  try {
    const relativePath = relative(workspacePath, absoluteFilePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      const segments = absoluteFilePath.split(/[\\/]/);
      return segments[segments.length - 1] || absoluteFilePath;
    }
    return relativePath.split('\\').join('/');
  } catch {
    return absoluteFilePath;
  }
}

/**
 * Build a human-friendly one-line label for a Claude tool call. This is generic
 * Claude-tool formatting (Edit/Read/Bash/…), NOT Scratch connector knowledge,
 * so it is safe to compute here and hand the renderer a finished string.
 *
 * @internal — exported for vitest.
 */
export function formatToolUseLabel(toolName: string, toolInput: unknown, workspacePath: string): string {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const rawFilePath =
    typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  const relativeFilePath = rawFilePath ? toWorkspaceRelativePathForDisplay(rawFilePath, workspacePath) : null;

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return relativeFilePath ? `Edited ${relativeFilePath}` : 'Edited a file';
    case 'Write':
      return relativeFilePath ? `Wrote ${relativeFilePath}` : 'Wrote a file';
    case 'Read':
      return relativeFilePath ? `Read ${relativeFilePath}` : 'Read a file';
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : null;
      return command ? `$ ${truncateForLabel(command, TOOL_LABEL_MAX_LENGTH)}` : 'Ran a command';
    }
    case 'Glob':
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : null;
      return pattern ? `Searched "${truncateForLabel(pattern, TOOL_PATTERN_MAX_LENGTH)}"` : 'Searched files';
    }
    case 'TodoWrite':
      return 'Updated its task list';
    case 'WebFetch':
    case 'WebSearch':
      return 'Searched the web';
    default:
      return `Used ${toolName}`;
  }
}

/** Parse one line of `stream-json` output, or `null` if it isn't a JSON object. */
function parseStreamJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Not every line is guaranteed to be JSON (defensive) — skip silently.
    return null;
  }
}

/**
 * Pure transform: one parsed `stream-json` object → zero or more normalized
 * events for the renderer. Stateless (no session/process bookkeeping) so the
 * whole event-shape contract can be unit-tested in isolation.
 *
 * Text is emitted from the partial `content_block_delta` deltas (token-by-token)
 * and the complete `assistant` message's text blocks are skipped, so prose is
 * never double-rendered; tool calls are read from the `assistant` message
 * (where their `input` is complete) rather than the partial input-json deltas.
 * Everything else — hook/status system events, `rate_limit_event`, `user`
 * tool-result echoes — normalizes to nothing.
 *
 * @internal — exported for vitest.
 */
export function normalizeClaudeStreamEvent(
  event: Record<string, unknown>,
  context: { requestId: string; workspacePath: string },
): ClaudeChatEvent[] {
  const { requestId, workspacePath } = context;
  const eventType = event.type;

  if (eventType === 'system') {
    if (event.subtype === 'init') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
      const model = typeof event.model === 'string' ? event.model : 'claude';
      if (sessionId) {
        return [{ requestId, type: 'session', sessionId, model }];
      }
    }
    return [];
  }

  if (eventType === 'stream_event') {
    const innerEvent = event.event as Record<string, unknown> | undefined;
    if (innerEvent && innerEvent.type === 'content_block_delta') {
      const delta = innerEvent.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
        return [{ requestId, type: 'assistant_text_delta', text: delta.text }];
      }
    }
    return [];
  }

  if (eventType === 'assistant') {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message?.content as Array<Record<string, unknown>>) : [];
    const normalizedEvents: ClaudeChatEvent[] = [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const toolUseId = typeof block.id === 'string' ? block.id : randomUUID();
        const toolName = typeof block.name === 'string' ? block.name : 'tool';
        normalizedEvents.push({
          requestId,
          type: 'tool_use',
          toolUse: { toolUseId, toolName, label: formatToolUseLabel(toolName, block.input, workspacePath) },
        });
      }
    }
    return normalizedEvents;
  }

  if (eventType === 'result') {
    const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
    const resultText = typeof event.result === 'string' ? event.result : null;
    return [{ requestId, type: 'result', isError, resultText }];
  }

  return [];
}

class ClaudeChatService {
  /** requestId → in-flight turn (for stop/teardown). */
  private activeTurnsByRequestId = new Map<string, ActiveTurn>();
  /** workspacePath → the `claude` session id to `--resume` for the next turn. */
  private sessionIdByWorkspacePath = new Map<string, string>();

  /** Probe for the BYO `claude` CLI so the renderer can prompt to install it. */
  checkAvailability(): ClaudeChatAvailability {
    const binaryPath = resolveClaudeBinaryPath();
    return { available: binaryPath !== null, binaryPath };
  }

  /** Forget a workspace's session so the next message starts a fresh chat. */
  resetSession(workspacePath: string): void {
    this.sessionIdByWorkspacePath.delete(workspacePath);
  }

  /**
   * Spawn `claude` for one chat turn and stream normalized events to `sender`.
   * The caller supplies `requestId` (minted in the renderer) so it can wire up
   * its event subscription BEFORE this runs, eliminating any first-event race.
   */
  startTurn(
    sender: WebContents,
    params: { workspacePath: string; message: string; requestId: string },
  ): StartClaudeChatTurnResult {
    const { workspacePath, message, requestId } = params;

    const binaryPath = resolveClaudeBinaryPath();
    if (!binaryPath) {
      throw new Error('The `claude` CLI was not found. Install Claude Code to chat from inside Scratch.');
    }

    const existingSessionId = this.sessionIdByWorkspacePath.get(workspacePath);
    const resumedExistingSession = existingSessionId !== undefined;
    const sessionId = existingSessionId ?? randomUUID();
    // Reserve the id up front so the (UI-disallowed) case of a second message
    // arriving mid-turn resumes this session rather than racing a new one.
    this.sessionIdByWorkspacePath.set(workspacePath, sessionId);

    const args = [
      '--print',
      message,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Run fully autonomous — the git review ladder (P2), not a permission
      // prompt, is the guardrail, and `-p` mode can't prompt anyway. Every edit
      // lands as a reviewable/revertible diff before anything publishes.
      '--dangerously-skip-permissions',
      ...(resumedExistingSession ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ];

    // NOTE: deliberately NOT wrapped in `beginInternalWorkspaceMutation` — the
    // agent's writes must be seen as external so the file watcher routes them
    // into the change-review ladder.
    const child = spawn(binaryPath, args, {
      cwd: workspacePath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.activeTurnsByRequestId.set(requestId, { requestId, child, webContentsId: sender.id, workspacePath });

    const emit = (event: ClaudeChatEvent): void => {
      if (sender.isDestroyed()) {
        return;
      }
      sender.send(CLAUDE_CHAT_EVENT_CHANNEL, event);
    };

    const parseState: TurnParseState = { sawResult: false };
    let stdoutBuffer = '';
    let stderrTail = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const event = parseStreamJsonLine(line);
        if (event) {
          for (const normalizedEvent of normalizeClaudeStreamEvent(event, { requestId, workspacePath })) {
            if (normalizedEvent.type === 'session') {
              // Authoritative session id (echoes our `--session-id` on a fresh turn).
              this.sessionIdByWorkspacePath.set(workspacePath, normalizedEvent.sessionId);
            } else if (normalizedEvent.type === 'result') {
              parseState.sawResult = true;
            }
            emit(normalizedEvent);
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_LENGTH);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      this.activeTurnsByRequestId.delete(requestId);
      emit({ requestId, type: 'error', message: `Failed to start Claude: ${error.message}` });
      emit({ requestId, type: 'exit', exitCode: -1 });
    });

    child.on('close', (code) => {
      this.activeTurnsByRequestId.delete(requestId);
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !parseState.sawResult) {
        emit({ requestId, type: 'error', message: stderrTail.trim() || `Claude exited with code ${exitCode}.` });
      }
      emit({ requestId, type: 'exit', exitCode });
    });

    return { requestId, resumedExistingSession };
  }

  /** SIGTERM a single in-flight turn (e.g. the user hit "Stop"). */
  stopTurn(requestId: string): void {
    const turn = this.activeTurnsByRequestId.get(requestId);
    if (!turn) {
      return;
    }
    this.activeTurnsByRequestId.delete(requestId);
    turn.child.kill('SIGTERM');
  }

  /** SIGTERM every in-flight turn (window close / app quit). */
  killAllTurns(): void {
    this.activeTurnsByRequestId.forEach((turn) => {
      turn.child.kill('SIGTERM');
    });
    this.activeTurnsByRequestId.clear();
  }
}

export const claudeChatService = new ClaudeChatService();
