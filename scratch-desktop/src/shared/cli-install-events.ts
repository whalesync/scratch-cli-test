/** Compact payloads for CLI install / uninstall outcomes forwarded from main to renderer. */
export type CliInstallEvent = { type: 'installed' } | { type: 'uninstalled' } | { type: 'failed'; message: string };

export const CLI_INSTALL_EVENT_CHANNEL = 'cli-install:event';
