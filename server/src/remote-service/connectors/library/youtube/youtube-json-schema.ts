import { Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import { ForeignKeyOptionSchema, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';

/**
 * Build a BaseJsonTableSpec from a YouTube channel.
 * Generates a JSON Schema describing the raw YouTube video API response format.
 */
export function buildYouTubeJsonTableSpec(id: EntityId, channelId: string, channelTitle: string): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      kind: Type.Optional(Type.String({ description: 'Resource type identifier', [X_SCRATCH_READONLY]: true })),
      etag: Type.Optional(Type.String({ description: 'ETag of this resource', [X_SCRATCH_READONLY]: true })),
      id: Type.String({ description: 'Unique video identifier', [X_SCRATCH_READONLY]: true }),
      snippet: Type.Optional(
        Type.Object(
          {
            publishedAt: Type.Optional(
              Type.String({ description: 'Video publish date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
            ),
            channelId: Type.Optional(
              Type.String({
                description: 'Channel ID',
                [X_SCRATCH_READONLY]: true,
                [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: `channel_${channelId}` },
              }),
            ),
            title: Type.Optional(Type.String({ description: 'Video title' })),
            description: Type.Optional(Type.String({ description: 'Video description' })),
            thumbnails: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description: 'Thumbnail images',
                [X_SCRATCH_READONLY]: true,
              }),
            ),
            channelTitle: Type.Optional(Type.String({ description: 'Channel title', [X_SCRATCH_READONLY]: true })),
            tags: Type.Optional(Type.Array(Type.String(), { description: 'Video tags' })),
            categoryId: Type.Optional(Type.String({ description: 'Video category ID' })),
            defaultLanguage: Type.Optional(Type.String({ description: 'Default language' })),
            defaultAudioLanguage: Type.Optional(Type.String({ description: 'Default audio language' })),
          },
          { description: 'Video snippet metadata' },
        ),
      ),
      contentDetails: Type.Optional(
        Type.Object(
          {
            duration: Type.Optional(
              Type.String({ description: 'Video duration in ISO 8601 format', [X_SCRATCH_READONLY]: true }),
            ),
            dimension: Type.Optional(Type.String({ description: '2d or 3d', [X_SCRATCH_READONLY]: true })),
            definition: Type.Optional(Type.String({ description: 'hd or sd', [X_SCRATCH_READONLY]: true })),
            caption: Type.Optional(Type.String({ description: 'Caption availability', [X_SCRATCH_READONLY]: true })),
            licensedContent: Type.Optional(
              Type.Boolean({ description: 'Licensed content flag', [X_SCRATCH_READONLY]: true }),
            ),
          },
          { description: 'Video content details' },
        ),
      ),
      status: Type.Optional(
        Type.Object(
          {
            uploadStatus: Type.Optional(Type.String({ description: 'Upload status', [X_SCRATCH_READONLY]: true })),
            privacyStatus: Type.Optional(Type.String({ description: 'Privacy status: public, unlisted, or private' })),
            license: Type.Optional(Type.String({ description: 'Video license' })),
            embeddable: Type.Optional(Type.Boolean({ description: 'Can video be embedded' })),
            publicStatsViewable: Type.Optional(Type.Boolean({ description: 'Public stats visibility' })),
            madeForKids: Type.Optional(Type.Boolean({ description: 'Made for kids flag', [X_SCRATCH_READONLY]: true })),
          },
          { description: 'Video status information' },
        ),
      ),
      statistics: Type.Optional(
        Type.Object(
          {
            viewCount: Type.Optional(Type.String({ description: 'View count', [X_SCRATCH_READONLY]: true })),
            likeCount: Type.Optional(Type.String({ description: 'Like count', [X_SCRATCH_READONLY]: true })),
            commentCount: Type.Optional(Type.String({ description: 'Comment count', [X_SCRATCH_READONLY]: true })),
          },
          { description: 'Video statistics' },
        ),
      ),
    },
    {
      $id: `youtube/${channelId}`,
      title: channelTitle,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: channelTitle,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['snippet', 'title'],
    mainContentColumnRemoteId: ['snippet', 'description'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convert a dot-notation field path (e.g. "snippet.channelId") to a JSON pointer
 * path through nested properties in the schema.
 */
function fieldToPointer(field: string): string {
  return '/properties/' + field.split('.').join('/properties/');
}

/**
 * Checks if a field is readonly.
 * @param field - The dot-notation field path (e.g. "id", "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_READONLY}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The dot-notation field path (e.g. "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) !== undefined;
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The dot-notation field path (e.g. "snippet.channelId").
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `${fieldToPointer(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
