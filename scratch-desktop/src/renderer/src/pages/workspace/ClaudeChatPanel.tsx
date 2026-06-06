import { ButtonPrimarySolid, IconButtonGhost } from '@/components/base/buttons';
import { Text12Regular, Text13Regular, Text16Medium, TextMono12Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Loader, Stack, Textarea } from '@mantine/core';
import { ArrowUp, MessageSquarePlus, Sparkles, Square, Terminal, Wrench } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useClaudeChat, type ClaudeChatMessage } from '../../hooks/use-claude-chat';
import { RichTextMarkdown } from './RichTextMarkdown';

const CLAUDE_DOWNLOAD_URL = 'https://claude.ai/download';

interface ClaudeChatPanelProps {
  workspacePath: string;
  workspaceId: string;
}

/**
 * Embedded Claude chat (Approach A) — the primary center-pane "tab". Streams the
 * `claude` CLI into the panel: chat → Claude edits records → switch to the grid
 * tab to review the edits → chat more, all without leaving Scratch. The panel
 * holds NO connector-specific knowledge — it renders the normalized event stream
 * the main process hands it.
 */
export function ClaudeChatPanel({ workspacePath, workspaceId }: ClaudeChatPanelProps) {
  const { messages, isStreaming, model, availability, sendMessage, stop, newChat } = useClaudeChat(
    workspacePath,
    workspaceId,
  );
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Stick the transcript to the bottom as content streams in.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages]);

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || isStreaming) {
      return;
    }
    sendMessage(text);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Group
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}
        px={14}
        py={8}
        align="center"
        justify="space-between"
      >
        <Group gap={8} align="center" style={{ minWidth: 0 }}>
          <StyledLucideIcon Icon={Sparkles} size={16} c="var(--fg-secondary)" />
          <Text16Medium c="var(--fg-primary)">Claude</Text16Medium>
          {model && (
            <TextMono12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap' }}>
              {model}
            </TextMono12Regular>
          )}
        </Group>
        <IconButtonGhost
          size="compact-xs"
          aria-label="New chat"
          disabled={messages.length === 0 && !isStreaming}
          onClick={newChat}
        >
          <StyledLucideIcon Icon={MessageSquarePlus} size="sm" />
        </IconButtonGhost>
      </Group>

      {/* Transcript */}
      <Box ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} px={14} py={12}>
        {availability === null ? (
          <Group justify="center" py="lg">
            <Loader size="sm" />
          </Group>
        ) : !availability.available ? (
          <ClaudeUnavailableNotice />
        ) : messages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <Stack gap={16}>
            {messages.map((message) => (
              <ChatMessageRow key={message.id} message={message} />
            ))}
          </Stack>
        )}
      </Box>

      {/* Composer */}
      <Box style={{ borderTop: '0.5px solid var(--fg-divider)', flexShrink: 0 }} px={12} py={10}>
        <Group gap={8} align="flex-end" wrap="nowrap">
          <Textarea
            style={{ flex: 1 }}
            autosize
            minRows={1}
            maxRows={6}
            placeholder={
              availability?.available === false ? 'Install Claude Code to chat' : 'Ask Claude to edit records…'
            }
            value={draft}
            disabled={availability?.available === false}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          {isStreaming ? (
            <IconButtonGhost aria-label="Stop" onClick={stop}>
              <StyledLucideIcon Icon={Square} size="sm" />
            </IconButtonGhost>
          ) : (
            <ButtonPrimarySolid
              px={10}
              aria-label="Send message"
              disabled={!draft.trim() || availability?.available === false}
              onClick={handleSend}
            >
              <StyledLucideIcon Icon={ArrowUp} size="sm" />
            </ButtonPrimarySolid>
          )}
        </Group>
      </Box>
    </Stack>
  );
}

function ChatMessageRow({ message }: { message: ClaudeChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
        <Box
          px={12}
          py={8}
          style={{
            backgroundColor: 'var(--bg-selected)',
            borderRadius: 10,
          }}
        >
          <Text13Regular c="var(--fg-primary)" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {message.text}
          </Text13Regular>
        </Box>
      </Box>
    );
  }

  const showThinking = message.status === 'streaming' && !message.text && message.tools.length === 0;

  return (
    <Stack gap={6} style={{ maxWidth: '100%' }}>
      {message.tools.length > 0 && (
        <Stack gap={4}>
          {message.tools.map((tool) => (
            <ToolUseRow key={tool.toolUseId} label={tool.label} />
          ))}
        </Stack>
      )}
      {showThinking ? (
        <Group gap={8} align="center">
          <Loader size="xs" />
          <Text13Regular c="var(--fg-muted)">Thinking…</Text13Regular>
        </Group>
      ) : message.status === 'streaming' ? (
        // Render live text as plain text (cheap) and switch to formatted
        // markdown once the turn completes.
        <Text13Regular c="var(--fg-primary)" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.text}
        </Text13Regular>
      ) : (
        message.text && <RichTextMarkdown markdown={message.text} />
      )}
      {message.status === 'error' && (
        <Box
          px={10}
          py={8}
          style={{
            backgroundColor: 'var(--mantine-color-red-light)',
            borderRadius: 8,
          }}
        >
          <Text12Regular c="var(--mantine-color-red-7)" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {message.errorText ?? 'Something went wrong.'}
          </Text12Regular>
        </Box>
      )}
    </Stack>
  );
}

function ToolUseRow({ label }: { label: string }) {
  const isCommand = label.startsWith('$ ');
  return (
    <Group gap={6} align="center" wrap="nowrap">
      <StyledLucideIcon Icon={isCommand ? Terminal : Wrench} size="xs" c="var(--fg-muted)" />
      <TextMono12Regular
        c="var(--fg-muted)"
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {label}
      </TextMono12Regular>
    </Group>
  );
}

function ChatEmptyState() {
  return (
    <Stack align="center" gap={8} py="lg" px="sm" style={{ textAlign: 'center' }}>
      <StyledLucideIcon Icon={Sparkles} size="xl" c="var(--fg-muted)" />
      <Text16Medium c="var(--fg-primary)">Chat with Claude</Text16Medium>
      <Text13Regular c="var(--fg-secondary)">
        Ask Claude to read or edit the records in this workspace. Open a folder on the left to review its changes in the
        grid tab, then approve and publish.
      </Text13Regular>
    </Stack>
  );
}

function ClaudeUnavailableNotice() {
  return (
    <Stack align="center" gap={10} py="lg" px="sm" style={{ textAlign: 'center' }}>
      <StyledLucideIcon Icon={Sparkles} size="xl" c="var(--fg-muted)" />
      <Text16Medium c="var(--fg-primary)">Claude Code isn’t installed</Text16Medium>
      <Text13Regular c="var(--fg-secondary)">
        Chatting in Scratch uses the Claude Code CLI signed in with your own Claude account. Install it, then reopen
        this panel.
      </Text13Regular>
      <ButtonPrimarySolid onClick={() => void window.scratchAuth.openExternal(CLAUDE_DOWNLOAD_URL)}>
        Get Claude Code
      </ButtonPrimarySolid>
    </Stack>
  );
}
