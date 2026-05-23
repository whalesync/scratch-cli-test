import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';

export type CloudSyncProvider = 'icloud' | 'dropbox' | 'onedrive' | 'googledrive' | 'box' | 'cloudstorage-other';

export interface CloudSyncDetection {
  provider: CloudSyncProvider;
  providerLabel: string;
  evidencePath: string;
}

export interface DetectCloudSyncOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveRealPath?: (target: string) => Promise<string>;
}

async function defaultRealPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

export async function detectCloudSync(
  absolutePath: string,
  opts: DetectCloudSyncOptions = {},
): Promise<CloudSyncDetection | null> {
  const home = opts.homeDir ?? homedir();
  const plat = opts.platform ?? platform();
  const env = opts.env ?? process.env;
  const resolveRealPath = opts.resolveRealPath ?? defaultRealPath;
  const realPath = await resolveRealPath(absolutePath);
  return plat === 'win32' ? detectWindows(realPath, home, env) : detectPosix(realPath, home);
}

function detectPosix(realPath: string, home: string): CloudSyncDetection | null {
  const iCloudRoot = `${home}/Library/Mobile Documents`;
  if (isUnder(realPath, iCloudRoot, '/')) {
    return { provider: 'icloud', providerLabel: 'iCloud Drive', evidencePath: iCloudRoot };
  }
  const cloudStorageRoot = `${home}/Library/CloudStorage`;
  if (isUnder(realPath, cloudStorageRoot, '/')) {
    const rest = realPath.slice(cloudStorageRoot.length + 1);
    const leaf = rest.split('/')[0] ?? '';
    return classifyCloudStorageLeaf(leaf, `${cloudStorageRoot}/${leaf}`);
  }
  for (const [name, provider, label] of [
    ['Dropbox', 'dropbox', 'Dropbox'],
    ['OneDrive', 'onedrive', 'OneDrive'],
  ] as const) {
    const root = `${home}/${name}`;
    if (isUnder(realPath, root, '/')) {
      return { provider, providerLabel: label, evidencePath: root };
    }
  }
  return null;
}

function classifyCloudStorageLeaf(leaf: string, evidencePath: string): CloudSyncDetection {
  const lower = leaf.toLowerCase();
  if (lower.startsWith('dropbox')) return { provider: 'dropbox', providerLabel: 'Dropbox', evidencePath };
  if (lower.startsWith('onedrive')) return { provider: 'onedrive', providerLabel: 'OneDrive', evidencePath };
  if (lower.startsWith('googledrive')) return { provider: 'googledrive', providerLabel: 'Google Drive', evidencePath };
  if (lower.startsWith('box')) return { provider: 'box', providerLabel: 'Box', evidencePath };
  return { provider: 'cloudstorage-other', providerLabel: 'a cloud-synced folder', evidencePath };
}

function detectWindows(realPath: string, home: string, env: NodeJS.ProcessEnv): CloudSyncDetection | null {
  const norm = realPath.toLowerCase();
  const homeNorm = home.toLowerCase();

  type Rule = { root: string; provider: CloudSyncProvider; providerLabel: string };
  const rules: Rule[] = [
    { root: `${homeNorm}\\dropbox`, provider: 'dropbox', providerLabel: 'Dropbox' },
    { root: `${homeNorm}\\google drive`, provider: 'googledrive', providerLabel: 'Google Drive' },
    { root: `${homeNorm}\\googledrive`, provider: 'googledrive', providerLabel: 'Google Drive' },
    { root: `${homeNorm}\\box`, provider: 'box', providerLabel: 'Box' },
    { root: `${homeNorm}\\box sync`, provider: 'box', providerLabel: 'Box' },
    { root: `${homeNorm}\\icloud drive`, provider: 'icloud', providerLabel: 'iCloud Drive' },
    { root: `${homeNorm}\\icloudphotos`, provider: 'icloud', providerLabel: 'iCloud Photos' },
    { root: `${homeNorm}\\onedrive`, provider: 'onedrive', providerLabel: 'OneDrive' },
  ];

  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const value = env[key];
    if (value && value.trim()) {
      rules.push({
        root: value.replace(/\\$/, '').toLowerCase(),
        provider: 'onedrive',
        providerLabel: 'OneDrive',
      });
    }
  }

  for (const rule of rules) {
    if (isUnder(norm, rule.root, '\\')) {
      const evidencePath = realPath.slice(0, rule.root.length);
      return { provider: rule.provider, providerLabel: rule.providerLabel, evidencePath };
    }
  }
  return null;
}

function isUnder(candidate: string, root: string, sep: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}
