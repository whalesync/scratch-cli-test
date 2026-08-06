/**
 * Assembly of the `claude://` / `codex://` deep links that the workspace "Open in…" menu uses to
 * launch a coding agent (DEV-10998 / Oneleet finding SCR-003).
 *
 * Everything here runs in the main process on purpose. Two separate things must stay out of the
 * renderer's hands:
 *
 * 1. **The scheme.** `claude:` and `codex:` are custom protocol handlers — exactly the class
 *    SCR-003 is about. The renderer names a product; main picks the scheme.
 * 2. **The prompt text.** The prompt is an instruction to an agent that can read and write files.
 *    If the renderer supplied it verbatim, a renderer compromise would be a way to hand an
 *    attacker-authored instruction to a coding agent — the scheme allowlist would be intact and
 *    the escalation would happen anyway. So main owns the template, and the renderer supplies
 *    only the data values that get slotted into it, each one constrained below.
 */

import type { AgentDeepLinkProduct } from '../shared/agent-deep-links';

/** Long enough for any real workspace name; short enough that it cannot carry a paragraph. */
const MAX_WORKSPACE_NAME_LENGTH = 120;

/** Deep enough for any real `connection/table` folder path. */
const MAX_FOLDER_RELATIVE_PATH_LENGTH = 512;

/** The agent instructions file each product looks for. */
const AGENT_INSTRUCTIONS_FILENAME: Record<AgentDeepLinkProduct, string> = {
  'claude-cowork': 'CLAUDE.md',
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
};

export interface AgentDeepLinkRequest {
  product: AgentDeepLinkProduct;
  /** Display name of the workspace, purely for the prompt's first sentence. */
  workspaceName: string | null;
  /** Absolute path to the workspace root. The caller must confine this to a real workspace. */
  workspacePath: string;
  /** Workspace-relative folder the user opened the menu from, if any (e.g. `airtable/Deals`). */
  selectedFolderRelativePath: string | null;
}

/**
 * Reduce a renderer-supplied display name to something that cannot carry instructions: no control
 * characters (so it stays one line), no quotes or backticks (so it cannot close the quoted slot it
 * sits in), and length-capped.
 */
function sanitizeWorkspaceNameForPrompt(workspaceName: string | null): string {
  if (!workspaceName) {
    return '';
  }
  return (
    workspaceName
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/["'`]/g, '')
      .trim()
      .slice(0, MAX_WORKSPACE_NAME_LENGTH)
  );
}

/**
 * A legitimate renderer only ever sends a plain workspace-relative POSIX folder path. Anything
 * else is a bug or an attack, so this throws rather than quietly dropping the clause — silently
 * changing what the agent is told is worse than refusing to launch.
 */
function assertUsableFolderRelativePath(selectedFolderRelativePath: string): void {
  const segments = selectedFolderRelativePath.split('/');
  const isPlainRelativePath =
    selectedFolderRelativePath.length <= MAX_FOLDER_RELATIVE_PATH_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f"'`\\]/.test(selectedFolderRelativePath) &&
    !selectedFolderRelativePath.startsWith('/') &&
    !segments.includes('..') &&
    !segments.includes('.');

  if (!isPlainRelativePath) {
    throw new Error(`Refusing to build an agent deep link for an unusable folder path: ${selectedFolderRelativePath}`);
  }
}

/** The prompt handed to the agent. Template owned by main; only the values come from the renderer. */
function buildAgentPrompt(request: AgentDeepLinkRequest): string {
  const workspaceName = sanitizeWorkspaceNameForPrompt(request.workspaceName);
  const agentInstructionsFilename = AGENT_INSTRUCTIONS_FILENAME[request.product];

  let prompt = `I'm working on my Scratch workspace, "${workspaceName}". It is described at \`${request.workspacePath}/${agentInstructionsFilename}\`.  `;

  // When the user opened the agent from a specific folder, scope it to that service folder so it
  // works on the Scratch files there instead of drifting out of scope (e.g. reaching for the
  // browser). The first path segment is the connection/service directory; the full relative path
  // is the table/folder.
  if (request.selectedFolderRelativePath) {
    assertUsableFolderRelativePath(request.selectedFolderRelativePath);
    const serviceFolderName = request.selectedFolderRelativePath.split('/')[0];
    prompt +=
      `I opened this from the \`${serviceFolderName}\` service — specifically the \`${request.selectedFolderRelativePath}\` folder ` +
      `(at \`${request.workspacePath}/${request.selectedFolderRelativePath}\`). Please focus your work on the Scratch files in that folder and ` +
      `stay scoped to the \`${serviceFolderName}\` service unless I tell you otherwise.`;
  }

  return prompt;
}

/**
 * Build the deep link that launches a coding agent at a workspace folder.
 *
 * Query parameters are percent-encoded, so no value can inject an extra parameter or escape into
 * the path, and `product` is branched on rather than interpolated — a renderer that lies about it
 * still cannot change the scheme.
 */
export function buildAgentDeepLinkUrl(request: AgentDeepLinkRequest): string {
  const encodedPrompt = encodeURIComponent(buildAgentPrompt(request));
  const encodedWorkspacePath = encodeURIComponent(request.workspacePath);

  if (request.product === 'codex') {
    return `codex://new?prompt=${encodedPrompt}&path=${encodedWorkspacePath}`;
  }

  const claudeProduct = request.product === 'claude-cowork' ? 'cowork' : 'code';
  return `claude://${claudeProduct}/new?q=${encodedPrompt}&folder=${encodedWorkspacePath}`;
}
