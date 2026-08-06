import { TranscriptToSrtOptions } from '@spinner/shared-types';
import { applyClientSafeTransformer, applyTranscriptToSrt } from '@spinner/shared-types/transform';
import { Service } from 'src/remote-service/connectors/service-constants';
import { transcriptToSrtTransformer } from '../implementations/transcript-to-srt.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

/** A Gong-shaped transcript: monologues (speaker turns) of ms-timed sentences. */
const GONG_SHAPED_TRANSCRIPT = [
  {
    speakerId: '6595241812183557927',
    topic: null,
    sentences: [
      { start: 190, end: 2770, text: 'reference haunted CRM generation two.' },
      { start: 2900, end: 7120, text: 'I understand the ticket says the CRM is haunted.' },
    ],
  },
  {
    speakerId: '8123456789012345678',
    topic: null,
    sentences: [{ start: 7400, end: 12050, text: 'Records we delete come back at three in the morning.' }],
  },
  {
    speakerId: '6595241812183557927',
    topic: null,
    sentences: [{ start: 12300, end: 15000, text: 'That is a sync loop, not a ghost.' }],
  },
];

const GONG_OPTIONS: TranscriptToSrtOptions = {
  speakerPath: 'speakerId',
  sentencesPath: 'sentences',
  textPath: 'text',
  startMsPath: 'start',
  endMsPath: 'end',
};

const EXPECTED_GONG_SRT = [
  '1',
  '00:00:00,190 --> 00:00:02,770',
  'Speaker 1: reference haunted CRM generation two.',
  '',
  '2',
  '00:00:02,900 --> 00:00:07,120',
  'Speaker 1: I understand the ticket says the CRM is haunted.',
  '',
  '3',
  '00:00:07,400 --> 00:00:12,050',
  'Speaker 2: Records we delete come back at three in the morning.',
  '',
  '4',
  '00:00:12,300 --> 00:00:15,000',
  'Speaker 1: That is a sync loop, not a ghost.',
].join('\n');

function createContext(sourceValue: unknown, options: TranscriptToSrtOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.GONG,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.NOTION,
    lookupTools: createNullLookupTools(),
    options,
    phase: 'DATA',
  };
}

describe('applyTranscriptToSrt (shared pure core)', () => {
  it('renders speaker-labeled SubRip cues, one per timed sentence, speakers numbered by first appearance', () => {
    const result = applyTranscriptToSrt(GONG_SHAPED_TRANSCRIPT, GONG_OPTIONS);
    expect(result).toEqual({ ok: true, value: EXPECTED_GONG_SRT });
  });

  it('handles hour-scale timestamps and omits labels without a speakerPath', () => {
    const flat_caption_list = [{ start: 3_723_456, end: 3_725_000, text: 'An hour in.' }];
    const result = applyTranscriptToSrt(flat_caption_list, {});
    expect(result).toEqual({
      ok: true,
      value: '1\n01:02:03,456 --> 01:02:05,000\nAn hour in.',
    });
  });

  it('skips sentences without text and clamps missing/invalid times to zero', () => {
    const transcript = [
      {
        speakerId: 's1',
        sentences: [
          { start: null, end: 'oops', text: 'Untimed but spoken.' },
          { start: 1, end: 2 },
        ],
      },
    ];
    const result = applyTranscriptToSrt(transcript, GONG_OPTIONS);
    expect(result).toEqual({
      ok: true,
      value: '1\n00:00:00,000 --> 00:00:00,000\nSpeaker 1: Untimed but spoken.',
    });
  });

  it('returns null for null input and empty transcripts, and fails on non-arrays', () => {
    expect(applyTranscriptToSrt(null, GONG_OPTIONS)).toEqual({ ok: true, value: null });
    expect(applyTranscriptToSrt([], GONG_OPTIONS)).toEqual({ ok: true, value: null });
    expect(applyTranscriptToSrt({ not: 'an array' }, GONG_OPTIONS).ok).toBe(false);
  });
});

describe('transcriptToSrtTransformer (server sync arm)', () => {
  it('has the registered type', () => {
    expect(transcriptToSrtTransformer.type).toBe('transcript_to_srt');
  });

  it('renders the Gong shape through the sync pipeline', async () => {
    const result = await transcriptToSrtTransformer.transform(createContext(GONG_SHAPED_TRANSCRIPT, GONG_OPTIONS));
    expect(result).toEqual({ success: true, value: EXPECTED_GONG_SRT });
  });

  it('parses a JSON-string source like the jsonpath arm', async () => {
    const result = await transcriptToSrtTransformer.transform(
      createContext(JSON.stringify(GONG_SHAPED_TRANSCRIPT), GONG_OPTIONS),
    );
    expect(result).toEqual({ success: true, value: EXPECTED_GONG_SRT });
  });

  it('fails (without falling back to the original) on a non-JSON string', async () => {
    const result = await transcriptToSrtTransformer.transform(createContext('not json', GONG_OPTIONS));
    expect(result).toEqual({
      success: false,
      error: 'Source value is a string that is not valid JSON',
      useOriginal: false,
    });
  });
});

describe('client-safe applier arm (grid display path)', () => {
  it('renders the same SRT the server arm produces', () => {
    const result = applyClientSafeTransformer(
      { type: 'transcript_to_srt', options: GONG_OPTIONS },
      GONG_SHAPED_TRANSCRIPT,
    );
    expect(result).toEqual({ ok: true, value: EXPECTED_GONG_SRT });
  });
});
