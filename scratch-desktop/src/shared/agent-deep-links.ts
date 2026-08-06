/**
 * The coding agents the workspace "Open in…" menu can launch.
 *
 * Only the identifier is shared across the process boundary. The `claude://` / `codex://` URL is
 * assembled in the main process (`src/main/external-url.ts`) on purpose — the renderer picks a
 * product, never a URL scheme (DEV-10998 / Oneleet SCR-003).
 */
export type AgentDeepLinkProduct = 'claude-cowork' | 'claude-code' | 'codex';
