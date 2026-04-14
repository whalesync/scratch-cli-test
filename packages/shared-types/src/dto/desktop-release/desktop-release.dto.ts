export interface DesktopReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface DesktopReleaseResponse {
  name: string;
  tagName: string;
  /** Plain semver extracted from the tag, e.g. "0.1.0" for tag "v0.1.0-desktop". */
  version: string;
  htmlUrl: string;
  publishedAt: string;
  channel: 'production' | 'test';
  assets: DesktopReleaseAsset[];
}
