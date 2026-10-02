import { Connector } from 'src/remote-service/connectors/connector';
import { isRemoteTableUnderCreateParent, resolveRemoteParentIdTheCreateWillLandIn } from '../create-parent-scope';

const NEW_SCHEMA_SENTINEL = 'scratch-new-schema-sentinel';
const splitSupabaseParent = (remoteParentId: string[]) =>
  remoteParentId.flatMap((segment) => segment.split('/')).filter((segment) => segment !== '');

/** Supabase's rules: flatten on `/`, default the schema to `public`, and land "New schema" in a named schema. */
const supabaseLike = {
  createDestinationIdForParent: (remoteParentId: string[]) => {
    const segments = splitSupabaseParent(remoteParentId);
    return segments[0] ? `${segments[0]}/${segments[1] ?? 'public'}` : undefined;
  },
  resolveRemoteParentIdTheCreateWillLandIn: (remoteParentId: string[], newParentName: string | undefined) => {
    const [projectRef, schema] = splitSupabaseParent(remoteParentId);
    if (!projectRef || schema !== NEW_SCHEMA_SENTINEL) return remoteParentId;
    return [projectRef, newParentName ?? 'scratch_export'];
  },
} as Pick<Connector, 'createDestinationIdForParent' | 'resolveRemoteParentIdTheCreateWillLandIn'>;

const singleSegment = {} as Pick<Connector, 'createDestinationIdForParent'>;

describe('resolveRemoteParentIdTheCreateWillLandIn', () => {
  it('returns the parent unchanged when the connector has no rule', () => {
    expect(resolveRemoteParentIdTheCreateWillLandIn(singleSegment, ['baseX'], 'Airtable export')).toEqual(['baseX']);
    expect(resolveRemoteParentIdTheCreateWillLandIn(singleSegment, undefined, 'Airtable export')).toBeUndefined();
  });

  it('defers to the connector rule when present', () => {
    expect(resolveRemoteParentIdTheCreateWillLandIn(supabaseLike, [`ref/${NEW_SCHEMA_SENTINEL}`], 'mkt')).toEqual([
      'ref',
      'mkt',
    ]);
    expect(resolveRemoteParentIdTheCreateWillLandIn(supabaseLike, ['ref/public'], 'mkt')).toEqual(['ref/public']);
  });
});

describe('isRemoteTableUnderCreateParent', () => {
  it('counts every table when no parent is given', () => {
    expect(isRemoteTableUnderCreateParent(singleSegment, ['baseX', 'tbl1'], undefined)).toBe(true);
    expect(isRemoteTableUnderCreateParent(singleSegment, ['baseX', 'tbl1'], [])).toBe(true);
  });

  it('matches a parent that prefixes the table remoteId when the connector has no fold', () => {
    expect(isRemoteTableUnderCreateParent(singleSegment, ['baseX', 'tbl1'], ['baseX'])).toBe(true);
    expect(isRemoteTableUnderCreateParent(singleSegment, ['baseY', 'tbl1'], ['baseX'])).toBe(false);
  });

  it('matches native segments through the fold', () => {
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'public', 'users'], ['ref', 'public'])).toBe(true);
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'other', 'users'], ['ref', 'public'])).toBe(false);
  });

  it('matches a parent given as the whole create-destination id (Live Export)', () => {
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'public', 'users'], ['ref/public'])).toBe(true);
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'other', 'users'], ['ref/public'])).toBe(false);
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['otherRef', 'public', 'users'], ['ref/public'])).toBe(false);
  });

  it('matches nothing for a parent that does not exist yet (the unresolved new-schema sentinel)', () => {
    expect(
      isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'public', 'users'], [`ref/${NEW_SCHEMA_SENTINEL}`]),
    ).toBe(false);
  });

  it('scopes a project-only parent to the schema the create defaults to', () => {
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'public', 'users'], ['ref'])).toBe(true);
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['ref', 'other', 'users'], ['ref'])).toBe(false);
  });

  it('never matches a single-segment table id by fold', () => {
    expect(isRemoteTableUnderCreateParent(supabaseLike, ['tbl1'], ['tbl1'])).toBe(false);
  });
});
