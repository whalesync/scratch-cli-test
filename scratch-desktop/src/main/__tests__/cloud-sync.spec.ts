import { describe, expect, it } from 'vitest';
import { detectCloudSync } from '../cloud-sync';

const macHome = '/Users/curtis';
const winHome = 'C:\\Users\\curtis';

const passthrough = (p: string): Promise<string> => Promise.resolve(p);
const mac = { homeDir: macHome, platform: 'darwin' as NodeJS.Platform, resolveRealPath: passthrough };
const win = (env: NodeJS.ProcessEnv = {}) => ({
  homeDir: winHome,
  platform: 'win32' as NodeJS.Platform,
  env,
  resolveRealPath: passthrough,
});

describe('detectCloudSync (macOS)', () => {
  it('returns null for paths outside cloud-sync roots', async () => {
    expect(await detectCloudSync(`${macHome}/Scratch/workspace-1`, mac)).toBeNull();
    expect(await detectCloudSync('/Volumes/External/Scratch', mac)).toBeNull();
    expect(await detectCloudSync('/tmp/foo', mac)).toBeNull();
  });

  it('detects iCloud Drive via ~/Library/Mobile Documents', async () => {
    const result = await detectCloudSync(`${macHome}/Library/Mobile Documents/com~apple~CloudDocs/Scratch`, mac);
    expect(result).toEqual({
      provider: 'icloud',
      providerLabel: 'iCloud Drive',
      evidencePath: `${macHome}/Library/Mobile Documents`,
    });
  });

  it('detects iCloud Drive after realpath dereferences ~/Desktop mirror', async () => {
    const desktopAlias = `${macHome}/Desktop/Scratch`;
    const result = await detectCloudSync(desktopAlias, {
      ...mac,
      resolveRealPath: (target) =>
        Promise.resolve(
          target === desktopAlias ? `${macHome}/Library/Mobile Documents/com~apple~CloudDocs/Desktop/Scratch` : target,
        ),
    });
    expect(result?.provider).toBe('icloud');
  });

  it('detects Dropbox via ~/Library/CloudStorage/Dropbox', async () => {
    const result = await detectCloudSync(`${macHome}/Library/CloudStorage/Dropbox/Scratch`, mac);
    expect(result).toEqual({
      provider: 'dropbox',
      providerLabel: 'Dropbox',
      evidencePath: `${macHome}/Library/CloudStorage/Dropbox`,
    });
  });

  it('detects OneDrive via ~/Library/CloudStorage/OneDrive-Personal', async () => {
    const result = await detectCloudSync(`${macHome}/Library/CloudStorage/OneDrive-Personal/Scratch`, mac);
    expect(result?.provider).toBe('onedrive');
    expect(result?.providerLabel).toBe('OneDrive');
  });

  it('detects Google Drive via ~/Library/CloudStorage/GoogleDrive-<email>', async () => {
    const result = await detectCloudSync(
      `${macHome}/Library/CloudStorage/GoogleDrive-curtis@whalesync.com/My Drive/Scratch`,
      mac,
    );
    expect(result?.provider).toBe('googledrive');
    expect(result?.providerLabel).toBe('Google Drive');
  });

  it('detects Box via ~/Library/CloudStorage/Box-<account>', async () => {
    const result = await detectCloudSync(`${macHome}/Library/CloudStorage/Box-curtis/Scratch`, mac);
    expect(result?.provider).toBe('box');
    expect(result?.providerLabel).toBe('Box');
  });

  it('detects an unknown CloudStorage provider as cloudstorage-other', async () => {
    const result = await detectCloudSync(`${macHome}/Library/CloudStorage/Acme-Sync/Scratch`, mac);
    expect(result?.provider).toBe('cloudstorage-other');
  });

  it('detects legacy ~/Dropbox install', async () => {
    const result = await detectCloudSync(`${macHome}/Dropbox/Scratch`, mac);
    expect(result?.provider).toBe('dropbox');
    expect(result?.evidencePath).toBe(`${macHome}/Dropbox`);
  });

  it('detects legacy ~/OneDrive install', async () => {
    const result = await detectCloudSync(`${macHome}/OneDrive/Scratch`, mac);
    expect(result?.provider).toBe('onedrive');
    expect(result?.evidencePath).toBe(`${macHome}/OneDrive`);
  });

  it('does not match prefix-similar safe paths', async () => {
    expect(await detectCloudSync(`${macHome}/DropboxBackup`, mac)).toBeNull();
    expect(await detectCloudSync(`${macHome}/Library/CloudStorageBackup`, mac)).toBeNull();
  });
});

describe('detectCloudSync (Windows)', () => {
  it('returns null for paths outside cloud-sync roots', async () => {
    expect(await detectCloudSync(`${winHome}\\Scratch\\workspace-1`, win())).toBeNull();
    expect(await detectCloudSync('D:\\Scratch', win())).toBeNull();
  });

  it('detects OneDrive via default user-home path', async () => {
    const result = await detectCloudSync(`${winHome}\\OneDrive\\Scratch`, win());
    expect(result?.provider).toBe('onedrive');
  });

  it('detects OneDrive via OneDriveCommercial env var (per-tenant path)', async () => {
    const tenantRoot = `${winHome}\\OneDrive - Microsoft`;
    const result = await detectCloudSync(`${tenantRoot}\\Scratch`, win({ OneDriveCommercial: tenantRoot }));
    expect(result?.provider).toBe('onedrive');
  });

  it('detects Dropbox', async () => {
    const result = await detectCloudSync(`${winHome}\\Dropbox\\Scratch`, win());
    expect(result?.provider).toBe('dropbox');
  });

  it('detects Google Drive', async () => {
    const result = await detectCloudSync(`${winHome}\\Google Drive\\My Drive\\Scratch`, win());
    expect(result?.provider).toBe('googledrive');
  });

  it('detects Box', async () => {
    const result = await detectCloudSync(`${winHome}\\Box\\Scratch`, win());
    expect(result?.provider).toBe('box');
  });

  it('detects iCloud Drive on Windows', async () => {
    const result = await detectCloudSync(`${winHome}\\iCloud Drive\\Scratch`, win());
    expect(result?.provider).toBe('icloud');
  });

  it('is case-insensitive on Windows paths', async () => {
    const result = await detectCloudSync(`C:\\USERS\\CURTIS\\OneDrive\\Scratch`, win());
    expect(result?.provider).toBe('onedrive');
  });
});
