import { TablePreview } from '../../../types';
import { WIX_BLOG_TABLE_DISPLAY_NAMES, WixBlogTableKey, wixBlogEntityId } from './wix-blog-tables';

export class WixBlogSchemaParser {
  /**
   * The tables this connector exposes, in the order a user most likely wants them.
   *
   * Categories, Tags and Members exist so the post foreign keys have somewhere to point: a post's
   * `categoryIds`/`tagIds`/`memberId` used to name tables the connector never listed, so the plan
   * marked them `needs_target` forever and the wizard's only option was to drop the column —
   * exporting posts with no categories, no tags and no author (DEV-11115).
   *
   * All three are read-only. Wix does support creating categories and tags, but this connector has
   * never exercised those write paths, and marking them writable would let a publish silently attempt
   * an untested call. Better to say "read-only" than to accept a write we can't stand behind.
   */
  parseTablePreviews(): TablePreview[] {
    const referenceTables: WixBlogTableKey[] = ['categories', 'tags', 'members'];
    return [
      { id: wixBlogEntityId('posts'), displayName: WIX_BLOG_TABLE_DISPLAY_NAMES.posts },
      ...referenceTables.map((table) => ({
        id: wixBlogEntityId(table),
        displayName: WIX_BLOG_TABLE_DISPLAY_NAMES[table],
        disabledCreates: true as const,
        disabledUpdates: true as const,
        disabledDeletes: true as const,
      })),
    ];
  }

  /** The Blog Posts table preview — this connector's primary table. */
  parseTablePreview(): TablePreview {
    return { id: wixBlogEntityId('posts'), displayName: WIX_BLOG_TABLE_DISPLAY_NAMES.posts };
  }
}
