/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { ConnectorAccount } from '@prisma/client';
import { ConnectorPullOptions, Service } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { YoutubeApiClient } from './youtube-api-client';
import { buildYouTubeJsonTableSpec } from './youtube-json-schema';

export class YouTubeConnector extends Connector<typeof Service.YOUTUBE> {
  readonly service = Service.YOUTUBE;
  static readonly displayName = 'YouTube';

  private readonly apiClient: YoutubeApiClient;

  constructor(
    private readonly accessToken: string,
    private readonly account: ConnectorAccount,
  ) {
    super();
    this.apiClient = new YoutubeApiClient(accessToken);
  }

  async testConnection(): Promise<void> {
    // Test connection by fetching user's channels
    await this.apiClient.getChannels();
  }

  async listTables(): Promise<TablePreview[]> {
    const channelsResponse = await this.apiClient.getChannels();

    if (!channelsResponse.items) {
      return [];
    }

    // Get the user's own channels (marked with mine: true)
    const ownChannels = channelsResponse.items.map(
      (channel) =>
        ({
          id: {
            wsId: `channel_${channel.id}`,
            remoteId: [channel.id || ''],
          },
          displayName: channel.snippet?.title || `Channel ${channel.id}`,
          metadata: {
            channelId: channel.id,
            channelTitle: channel.snippet?.title,
            description: channel.snippet?.description,
            publishedAt: channel.snippet?.publishedAt,
            mine: true,
          },
        }) satisfies TablePreview,
    );

    // Get additional channels from extras if they exist
    const additionalChannels: TablePreview[] = [];
    const accountWithExtras = this.account as ConnectorAccount & { extras?: Record<string, unknown> };
    if (
      accountWithExtras.extras &&
      typeof accountWithExtras.extras === 'object' &&
      'additionalChannels' in accountWithExtras.extras
    ) {
      const additionalChannelIds = accountWithExtras.extras.additionalChannels;
      if (Array.isArray(additionalChannelIds) && additionalChannelIds.length > 0) {
        try {
          // Fetch additional channels by their IDs
          const additionalChannelsResponse = await this.apiClient.getChannelsByIds(additionalChannelIds);
          if (additionalChannelsResponse.items) {
            additionalChannels.push(
              ...additionalChannelsResponse.items.map(
                (channel) =>
                  ({
                    id: {
                      wsId: `channel_${channel.id}`,
                      remoteId: [channel.id || ''],
                    },
                    displayName: channel.snippet?.title || `Channel ${channel.id}`,
                    metadata: {
                      channelId: channel.id,
                      channelTitle: channel.snippet?.title,
                      description: channel.snippet?.description,
                      publishedAt: channel.snippet?.publishedAt,
                      extra: true,
                    },
                  }) satisfies TablePreview,
              ),
            );
          }
        } catch (error) {
          console.debug('Failed to fetch additional channels:', error);
          // Continue without additional channels if there's an error
        }
      }
    }

    return [...ownChannels, ...additionalChannels];
  }

  /**
   * Fetch JSON Table Spec for YouTube videos.
   * Returns a schema describing the raw YouTube video API response format.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const channelId = id.remoteId[0];

    // Get channel info for display name
    const channelsResponse = await this.apiClient.getChannels();
    const channel = channelsResponse.items?.find((c) => c.id === channelId);
    const channelTitle = channel?.snippet?.title || `Channel ${channelId}`;

    return buildYouTubeJsonTableSpec(id, channelId, channelTitle);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    _options: ConnectorPullOptions,
  ): Promise<void> {
    WSLogger.info({ source: 'YouTubeConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });
    await callback({ files: [], connectorProgress: progress });
  }

  pullRecordFilesByIds(
    _tableSpec: BaseJsonTableSpec,
    _ids: string[],
    _callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    throw new Error('pullRecordFilesByIds is not implemented for YouTube');
  }

  getBatchSize(operation: 'create' | 'update' | 'delete'): number {
    // YouTube API has rate limits, so we use smaller batch sizes
    switch (operation) {
      case 'create':
        return 1; // YouTube doesn't support batch video creation
      case 'update':
        return 1; // YouTube doesn't support batch video updates
      case 'delete':
        return 1; // YouTube doesn't support batch video deletion
      default:
        return 1;
    }
  }

  /**
   * YouTube doesn't support creating videos through the API.
   * Videos must be uploaded through the YouTube interface.
   */
  createRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new Error(
      'YouTube does not support creating videos through the API. Videos must be uploaded through the YouTube interface.',
    );
  }

  /**
   * Update videos in YouTube from raw JSON files.
   * Files should have an 'id' field and snippet fields to update.
   */
  async updateRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const videoId = file.id as string;
      const updateData: Record<string, unknown> = {
        title: file.title,
        description: file.description,
        categoryId: file.categoryId,
        defaultLanguage: file.defaultLanguage,
        tags: file.tags,
      };

      if (Object.values(updateData).some((value) => value !== undefined)) {
        await this.apiClient.updateVideo(videoId, updateData);
      }

      if (file.transcript && file.transcriptId) {
        try {
          await this.apiClient.updateTranscript(videoId, file.transcriptId as string, file.transcript as string);
        } catch (error) {
          console.warn(`Failed to update transcript for video ${videoId}:`, error);
        }
      }
    }
  }

  /**
   * YouTube doesn't support deleting videos through the API.
   * Videos must be deleted through the YouTube interface.
   */
  deleteRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    return Promise.reject(
      new Error(
        'YouTube does not support deleting videos through the API. Videos must be deleted through the YouTube interface.',
      ),
    );
  }

  // private formatRecordWithoutTranscript(
  //   youtubeRecord: youtube_v3.Schema$Video,
  //   _tableSpec: YouTubeTableSpec,
  // ): ConnectorRecord {
  //   const videoId = youtubeRecord.id || '';

  //   return {
  //     id: videoId,
  //     fields: {
  //       title: youtubeRecord.snippet?.title || '',
  //       description: youtubeRecord.snippet?.description || '',
  //       url: this.getWatchVideoUrl(videoId),
  //       // dates should be coming in as ISO 8601 format in UTC
  //       publishedAt: youtubeRecord.snippet?.publishedAt ? new Date(youtubeRecord.snippet.publishedAt) : null,
  //       transcript: '', // Empty transcript - will be fetched via pullRecordDeep
  //       visibility: youtubeRecord.status?.privacyStatus || '',
  //       categoryId: youtubeRecord.snippet?.categoryId || '',
  //       defaultLanguage: youtubeRecord.snippet?.defaultLanguage || '',
  //       tags: youtubeRecord.snippet?.tags || [],
  //       studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
  //     },
  //   };
  // }

  // private getWatchVideoUrl(videoId?: string | null): string {
  //   if (!videoId) return '';
  //   return `https://www.youtube.com/watch?v=${videoId}`;
  // }

  // public override sanitizeRecordForUpdate(
  //   record: ExistingSnapshotRecord,
  //   tableSpec: YouTubeTableSpec,
  // ): SnapshotRecordSanitizedForUpdate {
  //   const { id, fields } = record;

  //   // For YouTube, we need to include all snippet fields since YouTube expects the full snippet to replace
  //   // But for transcript, we only include it if it was actually edited
  //   const editedFieldNames = tableSpec.columns
  //     .map((c) => c.id.wsId)
  //     .filter((colWsId) => !!record.__edited_fields[colWsId]);

  //   const newFields: typeof fields = {};

  //   // Always include these fields (YouTube snippet fields)
  //   newFields.title = fields.title;
  //   newFields.description = fields.description;
  //   newFields.categoryId = fields.categoryId;
  //   newFields.defaultLanguage = fields.defaultLanguage;
  //   newFields.tags = fields.tags;

  //   // Only include transcript if it was edited
  //   if (editedFieldNames.includes('transcript')) {
  //     newFields.transcript = fields.transcript;
  //     newFields.transcriptId = fields.transcriptId;
  //   }

  //   const sanitizedRecord: SnapshotRecordSanitizedForUpdate = {
  //     id,
  //     partialFields: newFields,
  //   };
  //   return sanitizedRecord;
  // }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    // TODO - parse the error more gracefully and return more specific error details.

    return {
      userFriendlyMessage: 'An error occurred while connecting to YouTube',
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
