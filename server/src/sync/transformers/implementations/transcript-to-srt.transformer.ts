import { Type } from '@sinclair/typebox';
import { TranscriptToSrtOptions, TransformerTypes } from '@spinner/shared-types';
import { applyTranscriptToSrt } from '@spinner/shared-types/transform';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Render a structured, speaker-attributed transcript (an array of speaker-turn
 * segments holding millisecond-timed sentences) as a standard SubRip (SRT)
 * document with "Speaker N:" labels — one cue per timed sentence.
 *
 * The segment/sentence shape is configured entirely by dot-path options, so the
 * transformer is connector-agnostic (Gong call transcripts wire
 * `{ speakerPath: 'speakerId', sentencesPath: 'sentences' }`; a flat pre-timed
 * caption list can omit `sentencesPath`). The rendering itself is the shared
 * pure core `applyTranscriptToSrt` (`@spinner/shared-types/transform`), which
 * the frontends also run via a View column's `codec.toCore` — keep the two
 * call sites in step.
 */
export const transcriptToSrtTransformer: FieldTransformer = {
  type: TransformerTypes.TranscriptToSrt,

  optionsSchema: [
    {
      key: 'speakerPath',
      widget: 'text',
      label: 'Speaker path',
      description: 'Dot path in each segment to its speaker identifier (omit for unlabeled cues)',
      placeholder: 'speakerId',
      defaultValue: '',
    },
    {
      key: 'sentencesPath',
      widget: 'text',
      label: 'Sentences path',
      description: 'Dot path in each segment to its timed-sentence array (omit if each segment is one sentence)',
      placeholder: 'sentences',
      defaultValue: '',
    },
    {
      key: 'textPath',
      widget: 'text',
      label: 'Text path',
      description: 'Dot path in each sentence to the spoken text',
      placeholder: 'text',
      defaultValue: 'text',
    },
    {
      key: 'startMsPath',
      widget: 'text',
      label: 'Start time path',
      description: 'Dot path in each sentence to its start time (milliseconds)',
      placeholder: 'start',
      defaultValue: 'start',
    },
    {
      key: 'endMsPath',
      widget: 'text',
      label: 'End time path',
      description: 'Dot path in each sentence to its end time (milliseconds)',
      placeholder: 'end',
      defaultValue: 'end',
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Union([Type.String(), Type.Null()]),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const transcript_options = options as TranscriptToSrtOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Sync-pipeline adapter (mirrors the jsonpath arm): parse a string source
    // as JSON, then map the shared pure core onto the sync TransformResult.
    let transcript_segments: unknown = sourceValue;
    if (typeof sourceValue === 'string') {
      try {
        transcript_segments = JSON.parse(sourceValue);
      } catch {
        return {
          success: false,
          error: 'Source value is a string that is not valid JSON',
          useOriginal: false,
        };
      }
    }

    const result = applyTranscriptToSrt(transcript_segments, transcript_options);
    if (!result.ok) {
      return { success: false, error: result.reason, useOriginal: false };
    }
    return { success: true, value: result.value };
  },
};

// Auto-register on import
registerTransformer(transcriptToSrtTransformer);
