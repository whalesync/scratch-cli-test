import { describe, expect, it } from 'vitest';
import { compareVersions, isVersionBelowMinimum } from '../version-compare';

describe('compareVersions', () => {
  it('orders by numeric core fields', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('compares field-by-field, not lexically (10 > 9)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('treats missing trailing fields as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0+abc123', '0.2.0')).toBe(0);
  });

  it('sorts a prerelease below the corresponding release', () => {
    expect(compareVersions('0.2.0-desktop-test.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0-desktop-test.1')).toBe(1);
  });

  it('returns null when either version is unparseable', () => {
    expect(compareVersions('not-a-version', '0.2.0')).toBeNull();
    expect(compareVersions('0.2.0', '')).toBeNull();
  });
});

describe('isVersionBelowMinimum', () => {
  it('is true only when strictly older', () => {
    expect(isVersionBelowMinimum('0.1.0', '0.2.0')).toBe(true);
    expect(isVersionBelowMinimum('0.2.0', '0.2.0')).toBe(false);
    expect(isVersionBelowMinimum('0.3.0', '0.2.0')).toBe(false);
  });

  it('fails open (returns false) when a version is unparseable, so a bad flag never locks the user out', () => {
    expect(isVersionBelowMinimum('garbage', '0.2.0')).toBe(false);
    expect(isVersionBelowMinimum('0.1.0', '')).toBe(false);
  });
});
