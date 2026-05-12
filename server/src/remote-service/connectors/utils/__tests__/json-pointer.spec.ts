import { escapePointerToken } from '../json-pointer';

describe('escapePointerToken', () => {
  it('passes plain ASCII tokens through unchanged', () => {
    expect(escapePointerToken('Name')).toBe('Name');
    expect(escapePointerToken('snippet.channelId')).toBe('snippet.channelId');
    expect(escapePointerToken('')).toBe('');
  });

  it('escapes `/` as `~1`', () => {
    expect(escapePointerToken('Date/heure de création')).toBe('Date~1heure de création');
    expect(escapePointerToken('a/b/c')).toBe('a~1b~1c');
  });

  it('escapes `~` as `~0`', () => {
    expect(escapePointerToken('a~b')).toBe('a~0b');
  });

  it('encodes `~` before `/` so `~1` from a slash is not double-encoded', () => {
    expect(escapePointerToken('a~/b')).toBe('a~0~1b');
    expect(escapePointerToken('~1')).toBe('~01');
  });

  it('handles Unicode characters', () => {
    expect(escapePointerToken('café/menu')).toBe('café~1menu');
  });
});
