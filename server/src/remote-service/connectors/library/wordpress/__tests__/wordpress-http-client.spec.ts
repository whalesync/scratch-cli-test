import { createApiClient } from '../../../create-api-client';
import { WordPressHttpClient } from '../wordpress-http-client';

jest.mock('../../../create-api-client');

describe('WordPressHttpClient', () => {
  describe('uploadMedia', () => {
    let mockPost: jest.Mock;
    let client: WordPressHttpClient;

    beforeEach(() => {
      mockPost = jest.fn().mockResolvedValue({ data: { id: 1 } });
      (createApiClient as jest.Mock).mockReturnValue({ post: mockPost });
      client = new WordPressHttpClient('https://example.com/wp-json/', 'user', 'pass');
    });

    function getContentDisposition(): string {
      const call = mockPost.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
      const headers = call[2].headers;
      return headers['Content-Disposition'];
    }

    it('should pass through a plain ASCII filename unchanged', async () => {
      await client.uploadMedia(Buffer.from('x'), 'photo.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="photo.png"');
    });

    it('should strip accents from characters like é, ü, ñ', async () => {
      await client.uploadMedia(Buffer.from('x'), 'café_résumé.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="cafe_resume.png"');
    });

    it('should replace emoji with underscores', async () => {
      await client.uploadMedia(Buffer.from('x'), 'logo_🎨.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="logo___.png"');
    });

    it('should replace CJK characters with underscores', async () => {
      await client.uploadMedia(Buffer.from('x'), '日本語.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="___.png"');
    });

    it('should escape double quotes in the filename', async () => {
      await client.uploadMedia(Buffer.from('x'), 'file"name.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="file\\"name.png"');
    });

    it('should handle a complex filename with accents, emoji, and CJK', async () => {
      await client.uploadMedia(Buffer.from('x'), 'café_résumé_🎨🐳💫_naïve_über_photo_日本語テスト.png', 'image/png');
      expect(getContentDisposition()).toBe('attachment; filename="cafe_resume________naive_uber_photo_______.png"');
    });
  });
});
