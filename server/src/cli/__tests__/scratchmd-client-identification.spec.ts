import { classifyScratchmdClientFromUserAgent, LEGACY_SCRATCHMD_USER_AGENT } from '../scratchmd-client-identification';

describe('classifyScratchmdClientFromUserAgent', () => {
  it('classifies the exact pre-DEV-13025 constant as a legacy binary', () => {
    expect(classifyScratchmdClientFromUserAgent(LEGACY_SCRATCHMD_USER_AGENT)).toEqual({
      scratchmdClientKind: 'legacy-scratchmd',
    });
  });

  it('reads the version of a standalone versioned build', () => {
    expect(classifyScratchmdClientFromUserAgent('Scratch-cli/1.0 scratchmd/0.4.2')).toEqual({
      scratchmdClientKind: 'scratchmd',
      scratchmdVersion: '0.4.2',
    });
  });

  it("reads both versions of Desktop's bundled build", () => {
    expect(classifyScratchmdClientFromUserAgent('Scratch-cli/1.0 scratchmd/0.1.0 scratch-desktop/1.0.150')).toEqual({
      scratchmdClientKind: 'scratchmd',
      scratchmdVersion: '0.1.0',
      scratchDesktopVersion: '1.0.150',
    });
  });

  it('keeps the Desktop version of a renderer request, which is not a scratchmd build', () => {
    expect(
      classifyScratchmdClientFromUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 scratch-desktop/1.0.150 Chrome/130.0 Electron/33.0.0 Safari/537.36',
      ),
    ).toEqual({ scratchmdClientKind: 'other', scratchDesktopVersion: '1.0.150' });
  });

  it.each([
    ['Bruno', 'Scratch-cli/1.0 bruno'],
    ['a browser', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0'],
    ['a legacy constant with extra spaces', ' Scratch-cli/1.0 '],
    ['a lowercase legacy constant', 'scratch-cli/1.0'],
    ['no User-Agent', undefined],
    ['an empty User-Agent', ''],
  ])('classifies %s as other', (_description, userAgent) => {
    expect(classifyScratchmdClientFromUserAgent(userAgent)).toEqual({ scratchmdClientKind: 'other' });
  });

  it('ignores a malformed or oversized version', () => {
    expect(classifyScratchmdClientFromUserAgent('Scratch-cli/1.0 scratchmd/')).toEqual({
      scratchmdClientKind: 'other',
    });
    expect(classifyScratchmdClientFromUserAgent(`Scratch-cli/1.0 scratchmd/${'9'.repeat(65)}`)).toEqual({
      scratchmdClientKind: 'other',
    });
    expect(classifyScratchmdClientFromUserAgent('Scratch-cli/1.0 scratchmd/1.0;drop')).toEqual({
      scratchmdClientKind: 'other',
    });
  });
});
