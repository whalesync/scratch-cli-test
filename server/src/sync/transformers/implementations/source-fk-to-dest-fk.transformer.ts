import { Type } from '@sinclair/typebox';
import { isScratchPendingPublishId, SourceFkToDestFkOptions, TransformerTypes } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, FkMappingResult, TransformContext, TransformResult } from '../transformer.types';

/**
 * Transforms a source foreign key ID to the corresponding destination foreign key ID.
 * Uses SyncRemoteIdMapping to resolve source FK values to destination IDs.
 *
 * Options:
 * - referencedDataFolderId: The source DataFolder ID of the referenced table mapping
 * - onUnresolved: 'fail' (default) stops the sync; 'ignore' skips unresolved FKs with a warning
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
      defaultValue: 'fail',
      selectOptions: [
        { value: 'fail', label: 'Stop and fail the sync' },
        { value: 'ignore', label: 'Ignore missing record and sync the rest' },
      ],
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as SourceFkToDestFkOptions;
    const ignoreUnresolved = typedOptions.onUnresolved === 'ignore';
    // Sentinels the SOURCE service writes to mean "not linked" (WordPress `featured_media: 0`).
    // Declared by the connector on the field's foreign-key annotation, so they can be dropped
    // as deliberately-empty rather than hunted for as ids that will never be found.
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
    const warnings: string[] = [];
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

      // Step 2 — the target's remote id names a destination record.
      const destinationResolution =
        target.kind === 'resolved'
          ? await lookupTools.getDestinationMappingForSourceFk(
              target.targetSourceRemoteId,
              typedOptions.referencedDataFolderId,
            )
          : ({ kind: 'no_destination_record' } as const);

      // The destination record is known but the connection it lives in is not, so no
      // workspace-absolute pseudo-ref can be built — and that is the only form we may write.
      // Dropping the link instead would be a silent lie, so fail the field even under
      // `onUnresolved: 'ignore'` (that tolerance is for targets we can't FIND, not for targets
      // we can't ADDRESS).
      if (destinationResolution.kind === 'destination_connection_unresolved') {
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

      if (destinationResolution.kind === 'no_destination_record') {
        // Distinguish "nothing has that key" from "found the record, but it has no destination
        // row yet" — they have completely different causes and fixes.
        const reason =
          target.kind === 'no_match'
            ? `no record in DataFolder ${typedOptions.referencedDataFolderId} has ${describeTargetKey(typedOptions.targetKeyPath)} "${fkStr}"`
            : `it has no destination record in DataFolder ${typedOptions.referencedDataFolderId}`;
        if (ignoreUnresolved) {
          const msg = `Skipped unresolved foreign key "${fkStr}": ${reason}`;
          warnings.push(msg);
          WSLogger.warn({
            source: 'sourceFkToDestFkTransformer',
            message: msg,
            sourceRecordId: ctx.sourceRecord.id,
            sourceFieldPath: ctx.sourceFieldPath,
          });
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

      // Check if the existing destination value already matches
      if (allMatch && destElements !== undefined) {
        allMatch = doesElementMatch(destElements, resolved.length - 1, ref, mapping);
      }
    }

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
