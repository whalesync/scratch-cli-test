// Locks down the two pure pieces of the embedded Claude chat (Approach A):
//
//   1. `normalizeClaudeStreamEvent` — the wire-shape contract that turns the
//      `claude` CLI's raw `stream-json` events into the small, connector-
//      agnostic event set the renderer consumes. The renderer never sees the
//      raw events, so this transform IS the contract.
//   2. `formatToolUseLabel` — the human-friendly one-line label for a tool call.
//
// Both are stateless, so they're tested directly with no process/IPC plumbing.

import { describe, expect, it } from 'vitest';
import type { ClaudeChatEvent } from '../../shared/claude-chat';
import { formatToolUseLabel, normalizeClaudeStreamEvent } from '../claude-chat';

const WORKSPACE = '/Users/test/Documents/ScratchWorkspaces/Demo';
const CONTEXT = { requestId: 'req-1', workspacePath: WORKSPACE };

function normalize(event: Record<string, unknown>): ClaudeChatEvent[] {
  return normalizeClaudeStreamEvent(event, CONTEXT);
}

describe('formatToolUseLabel', () => {
  it('labels file edits with a workspace-relative POSIX path', () => {
    expect(formatToolUseLabel('Edit', { file_path: `${WORKSPACE}/HubSpot/Posts/123.json` }, WORKSPACE)).toBe(
      'Edited HubSpot/Posts/123.json',
    );
    expect(formatToolUseLabel('Write', { file_path: `${WORKSPACE}/notes.md` }, WORKSPACE)).toBe('Wrote notes.md');
    expect(formatToolUseLabel('Read', { file_path: `${WORKSPACE}/AGENTS.md` }, WORKSPACE)).toBe('Read AGENTS.md');
  });

  it('collapses a path outside the workspace to just its filename (no home-dir leak)', () => {
    expect(formatToolUseLabel('Read', { file_path: '/etc/passwd' }, WORKSPACE)).toBe('Read passwd');
  });

  it('renders a Bash command with a `$` prefix and truncates long commands', () => {
    expect(formatToolUseLabel('Bash', { command: 'git status' }, WORKSPACE)).toBe('$ git status');
    const longCommand = 'echo ' + 'x'.repeat(200);
    const label = formatToolUseLabel('Bash', { command: longCommand }, WORKSPACE);
    expect(label.startsWith('$ echo ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(longCommand.length);
  });

  it('falls back gracefully when input is missing or the tool is unknown', () => {
    expect(formatToolUseLabel('Edit', {}, WORKSPACE)).toBe('Edited a file');
    expect(formatToolUseLabel('Grep', { pattern: 'TODO' }, WORKSPACE)).toBe('Searched "TODO"');
    expect(formatToolUseLabel('SomeFutureTool', { whatever: 1 }, WORKSPACE)).toBe('Used SomeFutureTool');
  });
});

describe('normalizeClaudeStreamEvent', () => {
  it('emits a session event (id + model) from system/init', () => {
    expect(normalize({ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude-opus-4-8' })).toEqual([
      { requestId: 'req-1', type: 'session', sessionId: 'abc-123', model: 'claude-opus-4-8' },
    ]);
  });

  it('ignores system/init without a session id, and other system subtypes', () => {
    expect(normalize({ type: 'system', subtype: 'init', model: 'x' })).toEqual([]);
    expect(normalize({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' })).toEqual([]);
    expect(normalize({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([]);
  });

  it('emits assistant_text_delta only from content_block_delta text_delta', () => {
    expect(
      normalize({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } },
      }),
    ).toEqual([{ requestId: 'req-1', type: 'assistant_text_delta', text: 'he' }]);
    // Non-text deltas and other stream events produce nothing.
    expect(
      normalize({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
      }),
    ).toEqual([]);
    expect(normalize({ type: 'stream_event', event: { type: 'message_start' } })).toEqual([]);
  });

  it('reads tool_use from the complete assistant message and skips its text blocks', () => {
    const events = normalize({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me edit that.' },
          { type: 'tool_use', id: 'tool_a', name: 'Edit', input: { file_path: `${WORKSPACE}/a.json` } },
          { type: 'tool_use', id: 'tool_b', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events).toEqual([
      {
        requestId: 'req-1',
        type: 'tool_use',
        toolUse: { toolUseId: 'tool_a', toolName: 'Edit', label: 'Edited a.json' },
      },
      { requestId: 'req-1', type: 'tool_use', toolUse: { toolUseId: 'tool_b', toolName: 'Bash', label: '$ ls' } },
    ]);
  });

  it('synthesizes a toolUseId when the assistant block has none', () => {
    const events = normalize({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use' });
    if (events[0].type === 'tool_use') {
      expect(events[0].toolUse.toolUseId.length).toBeGreaterThan(0);
    }
  });

  it('maps result events to success / error', () => {
    expect(normalize({ type: 'result', subtype: 'success', is_error: false, result: 'done' })).toEqual([
      { requestId: 'req-1', type: 'result', isError: false, resultText: 'done' },
    ]);
    expect(normalize({ type: 'result', subtype: 'error_max_turns', is_error: true })).toEqual([
      { requestId: 'req-1', type: 'result', isError: true, resultText: null },
    ]);
    // A non-success subtype counts as an error even if `is_error` is absent.
    expect(normalize({ type: 'result', subtype: 'error_during_execution' })).toEqual([
      { requestId: 'req-1', type: 'result', isError: true, resultText: null },
    ]);
  });

  it('ignores tool-result echoes and rate-limit noise', () => {
    expect(normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_a' }] } })).toEqual(
      [],
    );
    expect(normalize({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toEqual([]);
  });
});
