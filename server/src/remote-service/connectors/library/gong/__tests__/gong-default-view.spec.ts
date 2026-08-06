import { TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { buildGongDefaultView } from '../gong-default-view';
import {
  buildGongCallsJsonTableSpec,
  buildGongTranscriptsJsonTableSpec,
  buildGongUsersJsonTableSpec,
  gongTableWsId,
} from '../gong-json-schema';
import { GongEntityType } from '../gong-types';

const WORKSPACE_ID = '1299375510811165803';
const WORKSPACE_NAME = 'Initial workspace';

function flattenCols(view: { cols: (TableViewCol | TableViewBannerGroup)[] }): TableViewCol[] {
  return view.cols.flatMap((entry) => (entry.kind === 'banner-group' ? entry.cols : [entry]));
}

describe('buildGongDefaultView', () => {
  it('Calls view leads with human-recognizable columns and groups AI analysis structurally', () => {
    const spec = buildGongCallsJsonTableSpec(
      { wsId: gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID), remoteId: ['calls', WORKSPACE_ID] },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    const view = buildGongDefaultView(spec, { entityType: GongEntityType.CALLS, workspaceId: WORKSPACE_ID });
    expect(view).toBeDefined();
    if (!view) return;

    const first_visible_column_paths = view.cols
      .filter((entry): entry is TableViewCol => entry.kind === 'col' && !entry.hidden)
      .map((entry) => entry.path)
      .slice(0, 5);
    expect(first_visible_column_paths).toEqual([
      'metaData.title',
      'metaData.started',
      'metaData.duration',
      'metaData.direction',
      'metaData.primaryUserId',
    ]);

    const banner_group_names = view.cols
      .filter((entry): entry is TableViewBannerGroup => entry.kind === 'banner-group')
      .map((group) => group.name);
    expect(banner_group_names).toEqual(['AI Analysis', 'Interaction']);

    const all_columns = flattenCols(view);
    expect(all_columns.every((column) => column.readonly === true)).toBe(true);

    const host_column = all_columns.find((column) => column.path === 'metaData.primaryUserId');
    expect(host_column?.foreignKey?.linkedTableId).toBe('users');

    const participants_column = all_columns.find((column) => column.path === 'parties');
    expect(participants_column?.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].name', arrayHandling: 'join_comma' },
    });
    expect(participants_column?.logicalType).toBe('string');
  });

  it('Transcripts view links back to the workspace-scoped Calls table and flattens the transcript', () => {
    const spec = buildGongTranscriptsJsonTableSpec(
      { wsId: gongTableWsId(GongEntityType.TRANSCRIPTS, WORKSPACE_ID), remoteId: ['transcripts', WORKSPACE_ID] },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    const view = buildGongDefaultView(spec, { entityType: GongEntityType.TRANSCRIPTS, workspaceId: WORKSPACE_ID });
    expect(view).toBeDefined();
    if (!view) return;

    const call_column = flattenCols(view).find((column) => column.path === 'callId');
    // The FK token must be the bare remoteId segment (plan-generator candidate
    // token), with the exact workspace-scoped target in linkedTableRemoteId.
    expect(call_column?.foreignKey?.linkedTableId).toBe('calls');
    expect(call_column?.foreignKey?.linkedTableRemoteId).toEqual(['calls', WORKSPACE_ID]);

    const transcript_column = flattenCols(view).find((column) => column.path === 'transcript');
    // The SRT codec's toCore half drives both grid display and Live Export.
    expect(transcript_column?.codec?.toCore).toEqual({
      type: 'transcript_to_srt',
      options: {
        speakerPath: 'speakerId',
        sentencesPath: 'sentences',
        textPath: 'text',
        startMsPath: 'start',
        endMsPath: 'end',
      },
    });
    expect(transcript_column?.logicalType).toBe('string');
  });

  it('Users view covers every schema field (no column pointing at a nonexistent field, no field forgotten)', () => {
    const spec = buildGongUsersJsonTableSpec({ wsId: 'users', remoteId: ['users'] });
    const view = buildGongDefaultView(spec, { entityType: GongEntityType.USERS });
    expect(view).toBeDefined();
    if (!view) return;

    const schema_field_names = Object.keys(
      (spec.schema as unknown as { properties: Record<string, unknown> }).properties,
    ).sort();
    const view_column_paths = flattenCols(view)
      .map((column) => column.path)
      .sort();
    expect(view_column_paths).toEqual(schema_field_names);
  });
});
