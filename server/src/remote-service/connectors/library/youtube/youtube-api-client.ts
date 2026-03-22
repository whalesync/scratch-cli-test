import { youtube, youtube_v3 } from '@googleapis/youtube';
import { Readable } from 'stream';
// import { SyncProblem, SyncProblemCode } from '../types/sync-problem';
export class YoutubeApiClient {
  youtubeClient!: youtube_v3.Youtube;
  constructor(private readonly accessToken: string) {
    this.youtubeClient = youtube({ version: 'v3', headers: { Authorization: `Bearer ${this.accessToken}` } });
  }

  async getChannels(): Promise<youtube_v3.Schema$ChannelListResponse> {
    const channelResponse = await this.youtubeClient.channels.list({
      part: ['id', 'snippet'],
      mine: true,
      maxResults: 100,
    });
    return channelResponse.data;
  }

  async getChannelsByIds(channelIds: string[]): Promise<youtube_v3.Schema$ChannelListResponse> {
    const channelResponse = await this.youtubeClient.channels.list({
      part: ['id', 'snippet'],
      id: channelIds,
      maxResults: 100,
    });
    return channelResponse.data;
  }

  async getVideos(channelId: string, nextPageToken?: string): Promise<youtube_v3.Schema$VideoListResponse> {
    // Get videos from the specified channel (user's channel or brand channel they manage)
    // First, get the channel's uploads playlist ID
    const channelResponse = await this.youtubeClient.channels.list({
      part: ['contentDetails'],
      id: [channelId],
    });

    const uploadsPlaylistId = channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      throw new Error(`Could not find uploads playlist for channel ${channelId}`);
    }

    // Get videos from the uploads playlist (includes private videos)
    const playlistResponse = await this.youtubeClient.playlistItems.list({
      part: ['snippet'],
      playlistId: uploadsPlaylistId,
      maxResults: 100,
      pageToken: nextPageToken,
    });

    if (!playlistResponse.data.items || playlistResponse.data.items.length === 0) {
      return {
        items: [],
        nextPageToken: playlistResponse.data.nextPageToken,
        prevPageToken: playlistResponse.data.prevPageToken,
        pageInfo: playlistResponse.data.pageInfo,
        kind: 'youtube#videoListResponse',
        etag: playlistResponse.data.etag,
      } as youtube_v3.Schema$VideoListResponse;
    }

    // Get video IDs from playlist items
    const videoIds: string[] = [];
    for (const item of playlistResponse.data.items) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (typeof videoId === 'string') {
        videoIds.push(videoId);
      }
    }

    if (videoIds.length === 0) {
      return {
        items: [],
        nextPageToken: playlistResponse.data.nextPageToken,
        prevPageToken: playlistResponse.data.prevPageToken,
        pageInfo: playlistResponse.data.pageInfo,
        kind: 'youtube#videoListResponse',
        etag: playlistResponse.data.etag,
      } as youtube_v3.Schema$VideoListResponse;
    }

    // Get full video details including statistics and status
    const videosResponse = await this.youtubeClient.videos.list({
      part: ['snippet', 'id', 'statistics', 'status'],
      id: videoIds,
    });

    // Return with pagination info from playlist
    return {
      items: videosResponse.data.items || [],
      nextPageToken: playlistResponse.data.nextPageToken,
      prevPageToken: playlistResponse.data.prevPageToken,
      pageInfo: playlistResponse.data.pageInfo,
      kind: 'youtube#videoListResponse',
      etag: playlistResponse.data.etag,
    } as youtube_v3.Schema$VideoListResponse;
  }

  async getVideo(videoId: string): Promise<youtube_v3.Schema$VideoListResponse> {
    const searchResponse = await this.youtubeClient.videos.list({
      part: ['snippet', 'id', 'statistics', 'status'],
      id: [videoId],
    });
    return searchResponse.data;
  }

  // Somehow youtube forces you to send the category of the video to update it.
  async updateVideo(videoId: string, snippet: object): Promise<youtube_v3.Schema$Video> {
    const searchResponse = await this.youtubeClient.videos.update({
      part: ['snippet', 'id'],
      requestBody: {
        id: videoId,
        snippet,
      },
    });
    return searchResponse.data;
  }

  async getVideoTranscript(
    videoId: string,
  ): Promise<{ text: string; id: string | null; captionListItems: youtube_v3.Schema$Caption[] | null }> {
    let captionListItems: youtube_v3.Schema$Caption[] | null = null;
    try {
      // List available caption tracks for the video
      const captionListResponse = await this.youtubeClient.captions.list({
        part: ['snippet'],
        videoId: videoId,
      });

      // Find the English caption track
      let captionId: string | null = null;
      captionListItems = captionListResponse.data.items ?? null;
      if (captionListItems) {
        for (const item of captionListItems) {
          if (item.snippet?.language === 'en') {
            captionId = item.id || null;
            break;
          }
        }
      }

      if (!captionId) {
        console.debug(`No English transcript found for video ${videoId}`);
        return {
          text: `No English transcript found for video ${videoId}`,
          id: null,
          captionListItems,
        };
      }

      // Download the transcript
      const transcriptResponse = await this.youtubeClient.captions.download({
        id: captionId,
        tfmt: 'srt',
      });

      if (!transcriptResponse.data) {
        return {
          text: `No English transcript found for video ${videoId}`,
          id: null,
          captionListItems,
        };
      }

      // The response is a Blob, we need to convert it to string
      // Convert Blob to ArrayBuffer, then to Buffer, then to string
      const blob = transcriptResponse.data as Blob;
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const transcript = buffer.toString('utf-8');
      return { text: transcript, id: captionId, captionListItems };
    } catch (error: unknown) {
      // Handle specific error cases
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const statusError = error as { status: number; message?: string };
        if (statusError.status === 403) {
          return { text: `Access denied for transcript of video ${videoId}`, id: null, captionListItems };
        } else if (statusError.status === 404) {
          return { text: `No captions found for video ${videoId}`, id: null, captionListItems };
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        text: `Error fetching transcript for video ${videoId}: ${message}`,
        id: null,
        captionListItems,
      };
    }
  }

  async updateTranscript(videoId: string, transcriptId: string, transcriptText: string): Promise<void> {
    try {
      // First, we need to get the caption track details to update it
      const captionResponse = await this.youtubeClient.captions.list({
        part: ['snippet'],
        id: [transcriptId],
        videoId,
      });

      if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
        throw new Error(`Transcript with ID ${transcriptId} not found`);
      }

      const caption = captionResponse.data.items[0];
      if (!caption.snippet) {
        throw new Error(`Transcript ${transcriptId} has no snippet data`);
      }

      // Check if this is an auto-generated caption track
      // Auto-generated captions cannot be updated via the API, but we can replace them
      if (caption.snippet.trackKind === 'asr') {
        // Hide the auto-generated caption and create a new one
        await this.hideAutoGeneratedTranscript(videoId, transcriptId);
        const newTranscriptId = await this.createTranscript(videoId, transcriptText, caption.snippet.language || 'en');
        console.log(`Replaced auto-generated caption ${transcriptId} with new caption ${newTranscriptId}`);
        return; // Success - we've replaced the auto-generated caption
      }

      // Check if the caption track is in a state that allows updates
      if (caption.snippet.status === 'serving' || caption.snippet.status === 'failed') {
        throw new Error(
          `Cannot update caption track in '${caption.snippet.status}' status. Only draft captions can be updated.`,
        );
      }

      // Convert the transcript text to a readable stream for upload
      const transcriptStream = Readable.from([transcriptText]);

      // Update the caption track with the new content
      await this.youtubeClient.captions.update({
        part: ['snippet'],
        requestBody: {
          id: transcriptId,
          snippet: {
            ...caption.snippet,
            // Keep the existing snippet data but update the content
          },
        },
        media: {
          mimeType: 'text/plain',
          body: transcriptStream,
        },
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const statusError = error as { status: number; message?: string };
        if (statusError.status === 403) {
          // Check if this is specifically about auto-generated captions
          if (statusError.message?.includes('auto-generated') || statusError.message?.includes('ASR')) {
            throw new Error(`Cannot update auto-generated captions. Please upload a new caption track instead.`);
          }
          throw new Error(
            `Access denied for updating transcript ${transcriptId}. This may be an auto-generated caption that cannot be updated.`,
          );
        } else if (statusError.status === 404) {
          throw new Error(`Transcript ${transcriptId} not found`);
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error updating transcript ${transcriptId}: ${message}`);
    }
  }

  /**
   * Create a new caption track for a video
   * This is used to replace auto-generated captions that cannot be updated
   */
  async createTranscript(videoId: string, transcriptText: string, language: string = 'en'): Promise<string> {
    try {
      // Convert the transcript text to a readable stream for upload
      const transcriptStream = Readable.from([transcriptText]);

      // Create a new caption track
      const response = await this.youtubeClient.captions.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            videoId: videoId,
            language: language,
            name: 'User Uploaded Captions',
            isDraft: false, // Publish immediately
          },
        },
        media: {
          mimeType: 'text/plain',
          body: transcriptStream,
        },
      });

      if (!response.data.id) {
        throw new Error('Failed to create new caption track');
      }

      return response.data.id;
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const statusError = error as { status: number };
        if (statusError.status === 403) {
          throw new Error(`Access denied for creating transcript for video ${videoId}`);
        } else if (statusError.status === 404) {
          throw new Error(`Video ${videoId} not found`);
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error creating transcript for video ${videoId}: ${message}`);
    }
  }

  /**
   * Hide an auto-generated caption track by setting it to draft
   * This makes it invisible to viewers without deleting it
   */
  async hideAutoGeneratedTranscript(videoId: string, transcriptId: string): Promise<void> {
    try {
      // First, get the caption track details
      const captionResponse = await this.youtubeClient.captions.list({
        part: ['snippet'],
        id: [transcriptId],
        videoId,
      });

      if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
        throw new Error(`Transcript with ID ${transcriptId} not found`);
      }

      const caption = captionResponse.data.items[0];
      if (!caption.snippet) {
        throw new Error(`Transcript ${transcriptId} has no snippet data`);
      }

      // Only hide if it's an auto-generated caption
      if (caption.snippet.trackKind !== 'asr') {
        throw new Error(`Cannot hide non-auto-generated caption track`);
      }

      // Set the caption track to draft to hide it
      await this.youtubeClient.captions.update({
        part: ['snippet'],
        requestBody: {
          id: transcriptId,
          snippet: {
            ...caption.snippet,
            isDraft: true, // Hide the auto-generated caption
          },
        },
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const statusError = error as { status: number };
        if (statusError.status === 403) {
          throw new Error(`Access denied for hiding transcript ${transcriptId}`);
        } else if (statusError.status === 404) {
          throw new Error(`Transcript ${transcriptId} not found`);
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error hiding transcript ${transcriptId}: ${message}`);
    }
  }
}
