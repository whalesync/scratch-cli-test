import { Connector } from 'src/remote-service/connectors/connector';

type ParentAddressingConnector = Pick<
  Connector,
  'createDestinationIdForParent' | 'resolveRemoteParentIdTheCreateWillLandIn'
>;

/**
 * The parent a create into `remoteParentId` will actually land in. Usually the
 * parent itself; a connector whose "new container" destination can resolve to
 * one that already exists (Supabase's "New schema" folds `newParentName` into a
 * schema name and `CREATE SCHEMA IF NOT EXISTS`) names that container instead,
 * so a conflict check sees the tables a second export would land beside.
 */
export function resolveRemoteParentIdTheCreateWillLandIn(
  connector: ParentAddressingConnector,
  remoteParentId: string[] | undefined,
  newParentName: string | undefined,
): string[] | undefined {
  if (remoteParentId === undefined || !connector.resolveRemoteParentIdTheCreateWillLandIn) {
    return remoteParentId;
  }
  return connector.resolveRemoteParentIdTheCreateWillLandIn(remoteParentId, newParentName);
}

/**
 * Whether a remote table lives under the parent a create request targets.
 *
 * Callers address the parent in two shapes. The dev tool and materialize's
 * pinned parent use connector-native segments (`["baseX"]`, Supabase's
 * `["ref", "public"]`); Live Export forwards the create-destination id whole
 * (`["ref/public"]`). For a connector with a `createDestinationIdForParent`
 * fold, that fold is what decides where a create lands, so a table counts when
 * its own parent (its remoteId minus the last segment) folds to the same
 * create-destination id as the requested parent: `["ref/public"]`,
 * `["ref", "public"]` and `["ref"]` (schema defaulted) all mean `ref/public`.
 * Every other connector's parent is a plain prefix of the table's remoteId
 * (`["baseX"]` for `["baseX", "tblY"]`).
 *
 * A parent that names a container that does not exist yet (Supabase's "New
 * schema" sentinel) matches nothing, since no table lives there.
 *
 * No parent means every table counts: the caller does not know where the
 * table will be created, so it cannot narrow the check.
 */
export function isRemoteTableUnderCreateParent(
  connector: ParentAddressingConnector,
  remoteTableId: string[],
  remoteParentId: string[] | undefined,
): boolean {
  if (remoteParentId === undefined || remoteParentId.length === 0) {
    return true;
  }
  if (!connector.createDestinationIdForParent) {
    return remoteParentId.every((segment, index) => remoteTableId[index] === segment);
  }
  if (remoteTableId.length < 2) {
    return false;
  }
  const requestedCreateDestinationId = connector.createDestinationIdForParent(remoteParentId);
  const tableCreateDestinationId = connector.createDestinationIdForParent(remoteTableId.slice(0, -1));
  return requestedCreateDestinationId !== undefined && tableCreateDestinationId === requestedCreateDestinationId;
}
