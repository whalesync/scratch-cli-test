import { Type } from '@sinclair/typebox';
import {
  DataFolderId,
  isScratchPendingPublishId,
  Service,
  SourceFkToDestFkOptions,
  TransformerTypes,
} from '@spinner/shared-types';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { assertUnreachable } from 'src/utils/asserts';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import {
  FieldTransformer,
  FkMappingResult,
  NoDestinationRecordCause,
  TransformContext,
  TransformResult,
} from '../transformer.types';

/**
 * Transforms a source foreign key ID to the corresponding destination foreign key ID.
 * Uses SyncRemoteIdMapping to resolve source FK values to destination IDs.
 *
 * Options:
 * - referencedDataFolderId: The source DataFolder ID of the referenced table mapping
 * - onUnresolved: 'ignore' (default) warns instead of failing — it holds the field back rather than
 *   let the write erase a link the destination already holds, and otherwise leaves the unresolvable
 *   link empty (so resolvable links still land); 'fail' stops the sync
 *
 * Handles scalars, arrays, and null/undefined values.
 * Skips transformation when the destination already has the correct value.
 */
export const sourceFkToDestFkTransformer: FieldTransformer = {
  type: TransformerTypes.SourceFkToDestFk,

  optionsSchema: [
    {
      key: 'referencedDataFolderId',
      widget: 'folder_picker',
      label: 'Referenced Folder',
      description: 'The folder containing the records referenced by this foreign key',
      placeholder: 'Select folder',
      required: true,
      defaultValue: '',
    },
    {
      key: 'outputType',
      widget: 'select',
      label: 'Output type',
      description: 'Whether to output multiple values (array) or a single value',
      defaultValue: 'array',
      selectOptions: [
        { value: 'array', label: 'Multiple values (array)' },
        { value: 'single', label: 'Single value (first item)' },
      ],
    },
    {
      key: 'onUnresolved',
      widget: 'select',
      label: 'When a referenced record cannot be found',
      defaultValue: 'ignore',
      selectOptions: [
        { value: 'ignore', label: 'Leave the link empty and sync the rest' },
        { value: 'fail', label: 'Stop and fail the sync' },
      ],
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as SourceFkToDestFkOptions;
    // A DANGLING foreign key — one whose target is absent from the referenced source folder — is
    // normal in every CRM/billing source: the target was deleted upstream and the surviving records
    // keep its id forever (Stripe's deleted customers are retrievable by id but never LISTED, so a
    // pull can't see them). Left fatal it took the whole table down, and with it the run's publish
    // (DEV-11222). So the default is to leave that one link empty, count it, and warn — the same
    // "a link whose target is gone is an empty link, not a broken table" reasoning `valuesMeaningNoLink`
    // already applies one step in. `'fail'` remains available for a source where a dangling reference
    // really is a stop-the-line error.
    const ignoreUnresolved = typedOptions.onUnresolved !== 'fail';
    // Sentinels the SOURCE service writes to mean "not linked" (WordPress `featured_media: 0`).
    // Declared by the connector on the field's foreign-key annotation, so they can be dropped
    // as deliberately-empty rather than hunted for as ids that will never be found. Since an
    // undeclared dangling id no longer fails the record either (DEV-11222), what the declaration
    // now buys is SILENCE: a sentinel passes with no warning, where an id we genuinely could not
    // resolve raises one. Without it, every unlinked WordPress post would warn — one per record,
    // and a run reading "completed with warnings" over a value that was never a link.
    const valuesMeaningNoLink = new Set(typedOptions.valuesMeaningNoLink ?? []);

    // Handle null/undefined
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Normalize scalar to array for uniform processing
    const isSourceScalar = !Array.isArray(sourceValue);
    if (isSourceScalar && typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
      return {
        success: false,
        error: `Expected string, number, or array for FK value, got ${typeof sourceValue}`,
      };
    }
    const elements: unknown[] = isSourceScalar ? [sourceValue] : sourceValue;

    // Normalize destination value for comparison
    const destElements: unknown[] | undefined =
      destinationValue !== undefined
        ? Array.isArray(destinationValue)
          ? destinationValue
          : [destinationValue]
        : undefined;

    const resolved: string[] = [];
    // Every spelling a destination element may legitimately carry for a link we DID resolve (see
    // `destinationSpellingsForResolvedLink`). Used after the loop to tell "this write drops a link
    // the destination already holds" from "this write only adds" — the difference between erasing
    // data and making progress. Deliberately MORE permissive than `doesElementMatch`: that one
    // decides whether a write is needed, and must report a stale spelling as a change so it gets
    // upgraded; this one decides whether a link would be LOST, and a stale spelling of a link we
    // resolved is not a loss.
    const destinationSpellingsOfResolvedLinks = new Set<string>();
    // One entry per foreign key we could not resolve, naming the key and why. Held without the
    // consequence sentence because the consequence isn't known until the loop ends: whether the link
    // is emptied or the destination's existing one is preserved depends on what the destination holds.
    const unresolvedForeignKeyReports: string[] = [];
    let allMatch = destElements !== undefined;

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element === null || element === undefined) {
        continue;
      }
      if (typeof element !== 'string' && typeof element !== 'number') {
        return {
          success: false,
          error: `Expected string or number for FK array element, got ${typeof element}`,
        };
      }
      const fkStr = String(element);
      // A declared "no link" sentinel is an empty value, not a dangling reference — drop it
      // exactly as `null` is dropped above, and never fail the record over it. Checked BEFORE
      // step 1: the sentinel names no target, so there is nothing to look up by id or by key.
      if (valuesMeaningNoLink.has(fkStr)) {
        continue;
      }

      // Step 1 — the VALUE names a target record. With no `targetKeyPath` it already is that
      // record's remote id; with one, it is matched against that field of the referenced
      // folder's records (Framer names its targets by slug).
      const target = await lookupTools.resolveForeignKeyValueToTargetRemoteId(
        fkStr,
        typedOptions.referencedDataFolderId,
        typedOptions.targetKeyPath,
      );
      // An AMBIGUOUS key is always a hard error, even under `onUnresolved: 'ignore'`. "Ignore a
      // record I couldn't find" is a tolerance the user opted into; "silently pick one of two
      // records that claim this key" is a wrong link, and linking the wrong record is worse
      // than not linking at all.
      if (target.kind === 'ambiguous') {
        return {
          success: false,
          error:
            `Foreign key "${fkStr}" is ambiguous: ${target.matchCount} records in DataFolder ` +
            `${typedOptions.referencedDataFolderId} have ${describeTargetKey(typedOptions.targetKeyPath)} ` +
            `"${fkStr}". Make the value unique in the source, or reference the records by id.`,
        };
      }

      // Step 2 — the target's remote id names a destination record. A step-1 `no_match` produced
      // no remote id to look one up with, so it skips step 2 (`null`) and reports on its own.
      const destinationResolution =
        target.kind === 'resolved'
          ? await lookupTools.getDestinationMappingForSourceFk(
              target.targetSourceRemoteId,
              typedOptions.referencedDataFolderId,
            )
          : null;

      // The destination record is known but the connection it lives in is not, so no
      // workspace-absolute pseudo-ref can be built — and that is the only form we may write.
      // Dropping the link instead would be a silent lie, so fail the field even under
      // `onUnresolved: 'ignore'` (that tolerance is for targets we can't FIND, not for targets
      // we can't ADDRESS).
      if (destinationResolution?.kind === 'destination_connection_unresolved') {
        const message =
          `Could not build a reference for foreign key "${fkStr}": ${destinationResolution.reason}. ` +
          `Re-check the sync's destination table mapping for DataFolder ${typedOptions.referencedDataFolderId}.`;
        WSLogger.warn({
          source: 'sourceFkToDestFkTransformer',
          message,
          sourceRecordId: ctx.sourceRecord.id,
          sourceFieldPath: ctx.sourceFieldPath,
        });
        return { success: false, error: message };
      }

      if (destinationResolution === null || destinationResolution.kind === 'no_destination_record') {
        // `no_match` (only reachable with a `targetKeyPath`) is its own answer: the referenced
        // folder was searched by the declared key and nothing carries this value. Everything else
        // named a target and got no destination record for it, which `SyncRemoteIdMapping` can
        // now attribute to an actual cause rather than listing the possibilities (DEV-11223).
        const reason =
          destinationResolution === null
            ? `no record in DataFolder ${typedOptions.referencedDataFolderId} has ${describeTargetKey(typedOptions.targetKeyPath)} "${fkStr}"`
            : describeMissingDestinationRecord({
                cause: destinationResolution.cause,
                referencedFolderName: destinationResolution.referencedFolderName,
                referencedFolderService: destinationResolution.referencedFolderService,
                referencedDataFolderId: typedOptions.referencedDataFolderId,
                targetKeyPath: typedOptions.targetKeyPath,
                foreignKeyValue: fkStr,
              });
        if (ignoreUnresolved) {
          // No per-element log line: this is the DEFAULT path now, and a mature source reaches it
          // once per dangling reference across every record of the table (six figures on the run
          // that motivated DEV-11222). The warning is returned instead — the sync executor counts
          // every one and samples them onto the table's result with the source record's id.
          unresolvedForeignKeyReports.push(`Skipped unresolved foreign key "${fkStr}": ${reason}`);
          continue;
        }
        return {
          success: false,
          error: `Could not resolve foreign key "${fkStr}" to a destination path: ${reason}`,
        };
      }

      const mapping = destinationResolution.mapping;
      // Use the real destination remote ID if it exists already, otherwise a
      // pseudo-reference to the destination file. The pseudo-ref is always
      // workspace-absolute (connection folder first) per the canonical format —
      // prepend the destination connection folder to the connection-relative
      // destinationFilePath (DEV-10880).
      const ref =
        mapping.destinationRemoteId && !isScratchPendingPublishId(mapping.destinationRemoteId)
          ? mapping.destinationRemoteId
          : buildDestinationPseudoRef(mapping.destinationConnectionFolder, mapping.destinationFilePath);
      resolved.push(ref);
      for (const spelling of destinationSpellingsForResolvedLink(mapping, ref)) {
        destinationSpellingsOfResolvedLinks.add(spelling);
      }

      // Check if the existing destination value already matches
      if (allMatch && destElements !== undefined) {
        allMatch = doesElementMatch(destElements, resolved.length - 1, ref, mapping);
      }
    }

    // PRESERVE an existing link rather than erase it. Dropping an unresolvable foreign key empties
    // that link, and on a record the destination already holds a resolved link for, writing the
    // emptied field would publish an UNLINK to the destination service — destroying a correct link
    // because WE could not resolve the source's reference, not because the user removed it. The
    // source still names that target; we just can't map it. So hold the field back and warn.
    //
    // Gated on the write actually LOSING something, not merely on an unresolved key: on a
    // multi-value link, holding back whenever any sibling dangles would leave a perfectly
    // resolvable new entry unwritten for as long as the dangling one is missing — which, for a
    // hard-deleted CRM target, is forever. So a write that only ADDS to what the destination
    // already holds goes through, and only one that would drop an existing link is held back.
    //
    // A link the SOURCE no longer names is still removed normally: that arrives as a null or
    // shorter source value with nothing unresolved, so this guard never fires on it.
    const existingDestinationLinksThatWouldBeLost = (destElements ?? []).filter((element) => {
      if (element === null || element === undefined || element === '') {
        return false;
      }
      // Only the universally-empty values are excluded above. A service-specific "no link" sentinel
      // (WordPress's `featured_media: 0`) is NOT, and that is deliberate: `0` means "unlinked" only
      // where a connector declares it (`valuesMeaningNoLink`, DEV-11093/11094), and the destinations
      // that would exercise a hardcoded rule here are the scalar-FK ones — Postgres/Supabase, whose
      // integer FK column holding `0` is a row with that primary key, i.e. a REAL link. Excluding it
      // globally would re-open the erasure this guard exists to close. Counting a sentinel as
      // at-risk instead only costs a held-back write, and that write would have replaced the
      // service's own empty value (`0`) with ours (`null`) — so holding back is also the better
      // outcome. The warning below therefore says "a value", not "a link".
      // A destination whose link field is an ENVELOPE rather than a bare id (Notion's
      // `{ type: 'relation', relation: [{ id }] }` — and Notion is the destination in the run that
      // motivated this) hands us an object here, because `destinationValue` is the field's raw
      // stored value and the pack that builds the envelope runs AFTER this transformer. We can't
      // prove such an element is among the links we resolved, so we must not assume it is: treat it
      // as at-risk and hold the field back. Conservative in the right direction — the cost is that
      // an envelope-shaped destination doesn't get the add-through case below, and the alternative
      // is publishing an unlink against exactly the destination this bug was reported on.
      if (typeof element !== 'string' && typeof element !== 'number') {
        return true;
      }
      return !destinationSpellingsOfResolvedLinks.has(String(element));
    });
    if (unresolvedForeignKeyReports.length > 0 && existingDestinationLinksThatWouldBeLost.length > 0) {
      return {
        success: true,
        skip: true,
        warnings: unresolvedForeignKeyReports.map(
          (report) =>
            `${report}. Left the field untouched rather than drop a value the destination still ` +
            `holds; other changes to this field are deferred until it resolves.`,
        ),
      };
    }

    const warnings = unresolvedForeignKeyReports.map(
      (report) => `${report}. Left the link empty and synced the rest of the record.`,
    );

    // If all resolved elements match the existing destination value (and lengths match), skip
    if (allMatch && destElements !== undefined && resolved.length === destElements.length) {
      return warnings.length > 0 ? { success: true, skip: true, warnings } : { success: true, skip: true };
    }

    // Output shape: `outputType` is the DESTINATION-shape contract the sync builder set —
    // `'array'` means the destination link field holds a LIST, so even a SCALAR source (a
    // Webflow single-Reference id) resolves to a one-element array; without this, the scalar
    // leaked through to an array-consuming destination pack and failed the sync ("map_array
    // expects an array as input", DEV-10942). `'single'` means the destination holds one id
    // (a scalar-FK destination like Supabase) — first resolved id, rest dropped. When ABSENT
    // (legacy stored mappings predating outputType), mirror the source's shape as before.
    let value: string | string[] | null;
    if (typedOptions.outputType === 'array') {
      value = resolved;
    } else if (typedOptions.outputType === 'single' || isSourceScalar) {
      value = resolved[0] ?? null;
    } else {
      value = resolved;
    }
    return warnings.length > 0 ? { success: true, value, warnings } : { success: true, value };
  },
};

/**
 * Name the field a foreign key's value was matched against, for an error message: the declared
 * target key path, or "remote id" when the value is matched against the target's own id.
 */
function describeTargetKey(targetKeyPath: string | undefined): string {
  return targetKeyPath === undefined ? 'remote id' : `"${targetKeyPath}"`;
}

/**
 * Name the service a missing referenced record would have been deleted from. This is the REFERENCED
 * folder's own service, not the service of the pair being synced: a sync's table pairs are arbitrary
 * folder pairs, so an Airtable column's foreign key can name a Stripe source folder, and naming the
 * pair's source service would send the user looking in the wrong product. Falls back to the generic
 * phrase when the folder's service is unknown rather than guessing.
 */
function describeReferencedService(referencedFolderService: Service | null): string {
  return referencedFolderService === null ? 'the source service' : getServiceDisplayName(referencedFolderService);
}

/**
 * Name why a foreign key that named a target reached no destination record, and what the user
 * would do about it (DEV-11223).
 *
 * How much is PROVEN still differs with `targetKeyPath`, so the wording tracks it: with one, step 1
 * matched a real record in the referenced source folder, so "deleted in the source service" is
 * provably false and saying it would send a debugger the wrong way. Without one, step 1 echoed the
 * value back unverified, and `SyncRemoteIdMapping` is the only witness that the record was ever
 * seen — which is exactly what `cause` reports.
 */
function describeMissingDestinationRecord(args: {
  cause: NoDestinationRecordCause;
  referencedFolderName: string | null;
  referencedFolderService: Service | null;
  referencedDataFolderId: DataFolderId;
  targetKeyPath: string | undefined;
  foreignKeyValue: string;
}): string {
  // Always carry the DataFolder id, named or not, so a log search or a support thread can key on it.
  const referencedTable = args.referencedFolderName
    ? `"${args.referencedFolderName}" (DataFolder ${args.referencedDataFolderId})`
    : `DataFolder ${args.referencedDataFolderId}`;
  switch (args.cause) {
    case 'referenced_folder_synced_nothing': {
      // What is left UNPROVEN moves on two axes, and advice that reaches past either one is the
      // same over-claim the other branches avoid:
      //   - `referencedFolderName` is non-null only when a `SyncTablePair` was found, so a NAMED
      //     table is already known to be one of this sync's tables.
      //   - a declared `targetKeyPath` means step 1 streamed that folder off disk and matched a
      //     record in it, so the folder is already known to hold records.
      // Both halves being known is reachable: a real table pair produces no rows when the
      // referenced folder is empty, when its records all lack the match key the pair derives on
      // (`insertMatchKeys` skips those), or when `syncOneRecord` runs FOREIGN_KEY_MAPPING before
      // that pair's DATA phase has run for this sync.
      const matchKeyHint = 'check that its records carry the match key this sync pairs on';
      if (args.referencedFolderName === null) {
        return args.targetKeyPath === undefined
          ? `the referenced table ${referencedTable} synced no records at all — ` +
              `check that it is one of this sync's tables and has been pulled`
          : `the referenced table ${referencedTable} has records but synced none of them — ` +
              `check that it is one of this sync's tables`;
      }
      return args.targetKeyPath === undefined
        ? `the referenced table ${referencedTable} is one of this sync's tables but synced no records ` +
            `at all — check that it has been pulled, and ${matchKeyHint}`
        : `the referenced table ${referencedTable} is one of this sync's tables and has records, but ` +
            `synced none of them — ${matchKeyHint}`;
    }
    case 'referenced_record_awaiting_destination':
      return args.targetKeyPath === undefined
        ? `the referenced record was synced from ${referencedTable} but has not reached the destination yet`
        : `the record in ${referencedTable} whose ${describeTargetKey(args.targetKeyPath)} is ` +
            `"${args.foreignKeyValue}" was synced but has not reached the destination yet`;
    case 'referenced_record_not_synced':
      // Three fixes, because this cause has three sources: the target is gone upstream, it was
      // never pulled, or it IS on disk but the referenced pair's match-key derivation skipped it
      // (`insertMatchKeys` drops a record whose `deriveCanonicalMatchKey` returns null, so no
      // `SyncRemoteIdMapping` row is written for it). Listing only the first two would point away
      // from the third whenever the referenced pair uses `recordMatching`.
      return args.targetKeyPath === undefined
        ? `no record with that id was synced from the referenced table ${referencedTable} — ` +
            `it may have been deleted in ${describeReferencedService(args.referencedFolderService)}, ` +
            `never pulled into Scratch, or missing the match key this sync pairs on`
        : `the record in ${referencedTable} whose ${describeTargetKey(args.targetKeyPath)} is ` +
            `"${args.foreignKeyValue}" is present there but was not synced, so it has no destination record`;
    default:
      return assertUnreachable(args.cause);
  }
}

/**
 * Every spelling a destination element may legitimately carry for ONE link we resolved — used to
 * decide whether holding the field back is protecting a real link or freezing it for nothing.
 *
 * A stored element is not always the id we would emit today: the target may have PUBLISHED since
 * the sync that wrote it, so `ref` is now the real remote id while the record on disk still holds
 * the `@/…` pseudo-ref — publish resolves a pseudo-ref for the API call but leaves the on-disk
 * value alone (DEV-10954).
 *
 * Only the CANONICAL pseudo-ref counts. A ref in any other shape is malformed, not a link, and is
 * neither produced nor accepted anywhere (DEV-11238) — this must not become the one place that
 * quietly understands it.
 *
 * Missing a spelling that IS valid reads a still-correct link as one about to be lost, which holds
 * the field back — and because the hold-back is what would have rewritten the stale spelling to the
 * current one, the field then stays frozen on every later sync instead of just this one.
 */
function destinationSpellingsForResolvedLink(mapping: FkMappingResult, emittedRef: string): string[] {
  const spellings = [
    emittedRef,
    buildDestinationPseudoRef(mapping.destinationConnectionFolder, mapping.destinationFilePath),
  ];
  if (mapping.destinationRemoteId !== null) {
    spellings.push(mapping.destinationRemoteId);
  }
  return spellings;
}

/**
 * Build a workspace-absolute pseudo-reference (`@/<connection>/<folder>/<file>.json`)
 * for a destination record. `destinationFilePath` is connection-relative (no
 * connection segment, no leading slash); prepending the destination connection
 * folder reaches the canonical format.
 *
 * The connection segment is mandatory — the publish resolver accepts nothing else, so a ref
 * without one is a ref that fails at publish. `FkMappingResult` types
 * `destinationConnectionFolder` as a plain `string` precisely so this function cannot be
 * handed a missing one.
 */
function buildDestinationPseudoRef(destinationConnectionFolder: string, destinationFilePath: string): string {
  return `@/${destinationConnectionFolder}/${destinationFilePath}`;
}

/**
 * Checks whether a single resolved element matches the corresponding destination element.
 * A match means the existing value is either the resolved `@/path` pseudo-ref
 * or the raw `destinationRemoteId`.
 */
function doesElementMatch(
  destElements: unknown[],
  resolvedIndex: number,
  pseudoRef: string,
  mapping: FkMappingResult,
): boolean {
  if (resolvedIndex >= destElements.length) {
    return false;
  }
  const existing = destElements[resolvedIndex];
  if (String(existing) === pseudoRef) {
    return true;
  }
  if (mapping.destinationRemoteId !== null && String(existing) === String(mapping.destinationRemoteId)) {
    return true;
  }
  return false;
}

// Auto-register on import
registerTransformer(sourceFkToDestFkTransformer);
