import { TSchema, Type } from '@sinclair/typebox';
import { ColumnMapping, getTransformerLabel } from '@spinner/shared-types';
import { isEqual } from 'lodash';
import { getSchemaAtPath, isTypeCompatible } from '../schema-validator';
import { getTransformerConfigs } from './transformer-pipeline';
import { getTransformer } from './transformer-registry';

export interface ValidationResult {
  isValid: boolean;
  warnings: string[];
}

/** One step in the type pipeline: transformer name, input/output JSON schema types, or error */
export interface TypeTraceStep {
  transformerName: string;
  inputJsonSchemaType?: TSchema;
  outputJsonSchemaType?: TSchema;
  error?: string;
}

/** Validation errors per segment: after source, and after each step. Destination never has an error. */
export interface MappingTypeTraceValidation {
  source?: string;
  steps?: string[];
}

/** Full type trace for a single mapping: source → transformers → destination */
export interface MappingTypeTrace {
  sourceType: TSchema;
  steps: TypeTraceStep[];
  destinationType: TSchema;
  validation?: MappingTypeTraceValidation;
}

/**
 * Validates that the transformed source type for each mapping matches the destination type.
 * Traces the schema type through the pipeline of transformers using their `returnType` predictors.
 *
 * @param fieldMappingsForTable - The list of column mappings for a specific table sync.
 * @param sourceSchema - The JSON schema (TSchema) of the source table.
 * @param destSchema - The JSON schema (TSchema) of the destination table.
 */
export function validate(
  fieldMappingsForTable: ColumnMapping[],
  sourceSchema: TSchema,
  destSchema: TSchema,
): ValidationResult {
  const warnings: string[] = [];

  for (const mapping of fieldMappingsForTable) {
    const { sourceColumnId, destinationColumnId } = mapping;

    const initialSourceType = getSchemaAtPath(sourceSchema, sourceColumnId);
    const destinationType = getSchemaAtPath(destSchema, destinationColumnId);

    if (!initialSourceType) {
      warnings.push(`Source column "${sourceColumnId}" not found in source schema.`);
      continue;
    }

    if (!destinationType) {
      warnings.push(`Destination column "${destinationColumnId}" not found in destination schema.`);
      continue;
    }

    let currentType = initialSourceType;

    // Run the type through the transformer pipeline
    const configs = getTransformerConfigs(mapping);
    try {
      for (const config of configs) {
        const transformer = getTransformer(config.type);
        if (!transformer) {
          warnings.push(`Transformer "${config.type}" not found in registry.`);
          continue;
        }

        // If the transformer knows how to predict its return type, use it (may throw if input unsupported)
        if (transformer.returnType) {
          currentType = transformer.returnType(currentType, config.options);
        }
        // Otherwise, assume the transformer doesn't mutate the type, or we don't have enough info.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Type trace failed for mapping ${sourceColumnId} -> ${destinationColumnId}: ${message}`);
      continue;
    }

    // Compare the final predicted type to the destination type
    // We strip extraneous metadata like titles or descriptions for a stricter structural equality check
    if (!isEqualSchema(currentType, destinationType)) {
      warnings.push(
        `Type mismatch for mapping ${sourceColumnId} -> ${destinationColumnId}. Expected type \`${destinationType.type}\`, but pipeline resolved to \`${currentType.type}\`.`,
      );
    }
  }

  return {
    isValid: warnings.length === 0,
    warnings,
  };
}

/**
 * Traces the type through a single mapping's pipeline and returns source type,
 * each transformer step (name + output type), and destination type.
 * Each type is the raw JSON Schema fragment (TSchema) for display.
 */
export function traceMappingType(
  mapping: ColumnMapping,
  sourceSchema: TSchema,
  destSchema: TSchema,
): MappingTypeTrace | { error: string } {
  const sourceColumnId = mapping.sourceColumnId;
  const destinationColumnId = mapping.destinationColumnId;

  const sourceType = getSchemaAtPath(sourceSchema, sourceColumnId);
  const destinationType = getSchemaAtPath(destSchema, destinationColumnId);

  if (!sourceType) {
    return { error: `Source column "${sourceColumnId}" not found in source schema.` };
  }
  if (!destinationType) {
    return { error: `Destination column "${destinationColumnId}" not found in destination schema.` };
  }

  const steps: TypeTraceStep[] = [];
  let currentType: TSchema = sourceType;
  const configs = getTransformerConfigs(mapping);
  let pipelineFailed = false;

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const transformer = getTransformer(config.type);
    const label = getTransformerLabel(config.type);
    if (!transformer) {
      return { error: `Transformer "${config.type}" not found in registry.` };
    }
    // Declared input type for this transformer (what it accepts), not the previous step's output
    const inputJsonSchemaType = transformer.paramType ? transformer.paramType(config.options) : (Type.Any() as TSchema);
    if (pipelineFailed) {
      steps.push({
        transformerName: label,
        inputJsonSchemaType,
        error: 'Previous step failed',
      });
      continue;
    }
    if (transformer.returnType) {
      try {
        currentType = transformer.returnType(currentType, config.options);
        steps.push({
          transformerName: label,
          inputJsonSchemaType,
          outputJsonSchemaType: currentType,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          transformerName: label,
          inputJsonSchemaType,
          error: message,
        });
        pipelineFailed = true;
      }
    } else {
      steps.push({
        transformerName: label,
        inputJsonSchemaType,
        outputJsonSchemaType: currentType,
      });
    }
  }

  const validation = computeValidation(sourceType, steps, destinationType);

  return {
    sourceType,
    steps,
    destinationType,
    validation,
  };
}

/**
 * Runs isTypeCompatible at each boundary (source→first step, step i output→step i+1 input or destination).
 * Returns validation errors for the source and each step. Destination never has an error.
 */
function computeValidation(
  sourceType: TSchema,
  steps: TypeTraceStep[],
  destinationType: TSchema,
): MappingTypeTraceValidation {
  const result: MappingTypeTraceValidation = {};

  if (steps.length === 0) {
    if (!isTypeCompatible(sourceType, destinationType)) {
      result.source = 'Source type is not compatible with destination type.';
    }
    return result;
  }

  const firstStepInput = steps[0].inputJsonSchemaType;
  if (firstStepInput && !isTypeCompatible(sourceType, firstStepInput)) {
    result.source = 'Source type is not compatible with first step input.';
  }

  for (let i = 0; i < steps.length; i++) {
    const outputType = steps[i].outputJsonSchemaType;
    if (!outputType) continue;
    const nextInput = i + 1 < steps.length ? steps[i + 1].inputJsonSchemaType : destinationType;
    if (!nextInput) continue;
    if (!isTypeCompatible(outputType, nextInput)) {
      result.steps = result.steps ?? [];
      result.steps[i] =
        i + 1 < steps.length
          ? 'Step output type is not compatible with next step input.'
          : 'Step output type is not compatible with destination type.';
    }
  }

  return result;
}

/**
 * Helper to deep compare JSON schema types while ignoring styling metadata.
 */
function isEqualSchema(typeA: TSchema, typeB: TSchema): boolean {
  const cleanA = { ...typeA };
  const cleanB = { ...typeB };

  // Remove metadata properties that don't affect structural validation
  delete cleanA.description;
  delete cleanA.title;
  delete cleanA['x-scratch-connector-data-type'];
  delete cleanA['x-scratch-readonly'];
  delete cleanA['x-scratch-remote-field-id'];
  delete cleanA['x-scratch-suggested-transformer'];

  delete cleanB.description;
  delete cleanB.title;
  delete cleanB['x-scratch-connector-data-type'];
  delete cleanB['x-scratch-readonly'];
  delete cleanB['x-scratch-remote-field-id'];
  delete cleanB['x-scratch-suggested-transformer'];

  return isEqual(cleanA, cleanB);
}
