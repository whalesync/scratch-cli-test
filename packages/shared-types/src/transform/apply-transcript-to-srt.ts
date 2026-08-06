import type { TranscriptToSrtOptions } from '../sync-mapping';

/**
 * Pure core of the `transcript_to_srt` transformer: render a structured,
 * speaker-attributed transcript (an array of speaker-turn segments holding
 * millisecond-timed sentences) as a standard SubRip (SRT) document with
 * speaker labels:
 *
 *     1
 *     00:00:00,190 --> 00:00:02,770
 *     Speaker 1: reference haunted CRM generation two.
 *
 *     2
 *     00:00:02,900 --> 00:00:07,120
 *     Speaker 1: I understand the ticket says the CRM is haunted.
 *
 * One cue per timed sentence (real SubRip granularity). Speakers are labeled
 * "Speaker 1", "Speaker 2", … in order of first appearance of the value at
 * `speakerPath`; segments with no speaker value get no prefix. The shape is
 * configured entirely by dot paths, so the transformer carries no connector
 * knowledge (Gong wires `{ speakerPath: 'speakerId', sentencesPath:
 * 'sentences' }`; a flat pre-timed caption list can omit `sentencesPath`).
 *
 * Shared pure core used by BOTH the client-safe applier (grid display via a
 * column codec) and the server sync arm — keep them in step.
 */

export type TranscriptToSrtResult = { ok: true; value: string | null } | { ok: false; reason: string };

/** Walk a simple dot path ('a.b.c') through nested objects; undefined on any miss. */
function readDotPath(value: unknown, dot_path: string): unknown {
  let current: unknown = value;
  for (const path_segment of dot_path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[path_segment];
  }
  return current;
}

/** Format milliseconds as an SRT timestamp (HH:MM:SS,mmm). Negative/invalid clamps to zero. */
function formatSrtTimestamp(milliseconds: unknown): string {
  const total_ms =
    typeof milliseconds === 'number' && isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0;
  const hours = Math.floor(total_ms / 3_600_000);
  const minutes = Math.floor((total_ms % 3_600_000) / 60_000);
  const seconds = Math.floor((total_ms % 60_000) / 1000);
  const ms = total_ms % 1000;
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms, 3)}`;
}

export function applyTranscriptToSrt(value: unknown, options: TranscriptToSrtOptions): TranscriptToSrtResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'transcript_to_srt requires an array of transcript segments' };
  }

  const text_path = options.textPath ?? 'text';
  const start_ms_path = options.startMsPath ?? 'start';
  const end_ms_path = options.endMsPath ?? 'end';

  const speaker_label_by_raw_value = new Map<string, string>();
  const speakerLabelForSegment = (segment: unknown): string | undefined => {
    if (!options.speakerPath) return undefined;
    const raw_speaker_value = readDotPath(segment, options.speakerPath);
    // Only scalar speaker identifiers are labelable; an object here would
    // stringify uselessly, so treat it as "no speaker".
    if (typeof raw_speaker_value !== 'string' && typeof raw_speaker_value !== 'number') return undefined;
    if (raw_speaker_value === '') return undefined;
    const speaker_key = String(raw_speaker_value);
    const existing_label = speaker_label_by_raw_value.get(speaker_key);
    if (existing_label) return existing_label;
    const new_label = `Speaker ${speaker_label_by_raw_value.size + 1}`;
    speaker_label_by_raw_value.set(speaker_key, new_label);
    return new_label;
  };

  const srt_cues: string[] = [];
  for (const segment of value) {
    const speaker_label = speakerLabelForSegment(segment);
    // Without a sentencesPath the segment itself is one timed sentence.
    const sentences = options.sentencesPath ? readDotPath(segment, options.sentencesPath) : [segment];
    if (!Array.isArray(sentences)) continue;

    for (const sentence of sentences) {
      const sentence_text = readDotPath(sentence, text_path);
      if (typeof sentence_text !== 'string' || sentence_text === '') continue;
      const start_timestamp = formatSrtTimestamp(readDotPath(sentence, start_ms_path));
      const end_timestamp = formatSrtTimestamp(readDotPath(sentence, end_ms_path));
      const cue_text = speaker_label ? `${speaker_label}: ${sentence_text}` : sentence_text;
      srt_cues.push(`${srt_cues.length + 1}\n${start_timestamp} --> ${end_timestamp}\n${cue_text}`);
    }
  }

  return { ok: true, value: srt_cues.length > 0 ? srt_cues.join('\n\n') : null };
}
