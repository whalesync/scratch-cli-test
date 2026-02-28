import {
  ColumnMapping,
  DataFolderId,
  TransformerConfig,
  TransformerType,
  TransformerTypes,
} from '@spinner/shared-types';
import {
  applyTransformerPipeline,
  findTransformerConfigs,
  getTransformerConfigs,
  PipelineBaseContext,
} from '../transformer-pipeline';
import { FieldTransformer, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

// Import implementations to register transformers
import '../implementations/auto-convert.transformer';
import '../implementations/string-to-number.transformer';

// Also register a mock transformer for skip/failure testing
import { registerTransformer } from '../transformer-registry';

const mockSkipTransformer: FieldTransformer = {
  type: 'mock_skip' as TransformerType,
  transform: jest.fn().mockResolvedValue({ success: true, skip: true }),
};

const mockFailTransformer: FieldTransformer = {
  type: 'mock_fail' as TransformerType,
  transform: jest.fn().mockResolvedValue({ success: false, error: 'mock failure', useOriginal: true }),
};

const mockPassthroughTransformer: FieldTransformer = {
  type: 'mock_passthrough' as TransformerType,
  transform: jest
    .fn()
    .mockImplementation((ctx: TransformContext) => Promise.resolve({ success: true, value: ctx.sourceValue })),
};

registerTransformer(mockSkipTransformer);
registerTransformer(mockFailTransformer);
registerTransformer(mockPassthroughTransformer);

/** Helper to create a mock TransformerConfig for test-only transformer types */
function mockConfig(type: string): TransformerConfig {
  return { type } as unknown as TransformerConfig;
}

function createBaseCtx(overrides?: Partial<PipelineBaseContext>): PipelineBaseContext {
  const sourceRecord: SyncRecord = { id: 'rec-1', filePath: '/test.json', fields: { name: 'Alice' } };
  const lookupTools: LookupTools = {
    getDestinationMappingForSourceFk: jest.fn(),
    lookupFieldFromFkRecord: jest.fn(),
  };
  return {
    sourceRecord,
    sourceFieldPath: 'name',
    lookupTools,
    phase: 'DATA',
    ...overrides,
  };
}

// ─── getTransformerConfigs ─────────────────────────────────────────────────────

describe('getTransformerConfigs', () => {
  it('returns [transformer] when only transformer is set', () => {
    const config: TransformerConfig = { type: TransformerTypes.StringToNumber };
    const mapping: ColumnMapping = { sourceColumnId: 'a', destinationColumnId: 'b', transformer: config };
    expect(getTransformerConfigs(mapping)).toEqual([config]);
  });

  it('returns transformers array when transformers is set', () => {
    const configs: TransformerConfig[] = [
      { type: TransformerTypes.StringToNumber },
      { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } },
    ];
    const mapping: ColumnMapping = { sourceColumnId: 'a', destinationColumnId: 'b', transformers: configs };
    expect(getTransformerConfigs(mapping)).toEqual(configs);
  });

  it('returns empty array when neither is set', () => {
    const mapping: ColumnMapping = { sourceColumnId: 'a', destinationColumnId: 'b' };
    expect(getTransformerConfigs(mapping)).toEqual([]);
  });

  it('prefers transformers over transformer when both are set', () => {
    const single: TransformerConfig = { type: TransformerTypes.StringToNumber };
    const pipeline: TransformerConfig[] = [{ type: TransformerTypes.AutoConvert, options: { targetType: 'number' } }];
    const mapping: ColumnMapping = {
      sourceColumnId: 'a',
      destinationColumnId: 'b',
      transformer: single,
      transformers: pipeline,
    };
    expect(getTransformerConfigs(mapping)).toEqual(pipeline);
  });
});

// ─── findTransformerConfigs ────────────────────────────────────────────────────

describe('findTransformerConfigs', () => {
  it('finds config in single transformer', () => {
    const config: TransformerConfig = {
      type: TransformerTypes.LookupField,
      options: { referencedDataFolderId: 'df-1' as DataFolderId, referencedFieldPath: 'name' },
    };
    const mapping: ColumnMapping = { sourceColumnId: 'a', destinationColumnId: 'b', transformer: config };
    expect(findTransformerConfigs(mapping, TransformerTypes.LookupField)).toEqual([config]);
  });

  it('finds configs in transformers array', () => {
    const lookup1: TransformerConfig = {
      type: TransformerTypes.LookupField,
      options: { referencedDataFolderId: 'df-1' as DataFolderId, referencedFieldPath: 'name' },
    };
    const other: TransformerConfig = { type: TransformerTypes.StringToNumber };
    const lookup2: TransformerConfig = {
      type: TransformerTypes.LookupField,
      options: { referencedDataFolderId: 'df-2' as DataFolderId, referencedFieldPath: 'title' },
    };
    const mapping: ColumnMapping = {
      sourceColumnId: 'a',
      destinationColumnId: 'b',
      transformers: [lookup1, other, lookup2],
    };
    expect(findTransformerConfigs(mapping, TransformerTypes.LookupField)).toEqual([lookup1, lookup2]);
  });

  it('returns empty array when type not found', () => {
    const mapping: ColumnMapping = {
      sourceColumnId: 'a',
      destinationColumnId: 'b',
      transformer: { type: TransformerTypes.StringToNumber },
    };
    expect(findTransformerConfigs(mapping, TransformerTypes.LookupField)).toEqual([]);
  });

  it('returns empty array when no transformers', () => {
    const mapping: ColumnMapping = { sourceColumnId: 'a', destinationColumnId: 'b' };
    expect(findTransformerConfigs(mapping, TransformerTypes.LookupField)).toEqual([]);
  });
});

// ─── applyTransformerPipeline ──────────────────────────────────────────────────

describe('applyTransformerPipeline', () => {
  it('applies a single transformer step', async () => {
    const configs: TransformerConfig[] = [{ type: TransformerTypes.AutoConvert, options: { targetType: 'string' } }];
    const result = await applyTransformerPipeline(configs, 42, createBaseCtx());
    expect(result).toEqual({ success: true, value: '42' });
  });

  it('chains multiple transformers — output feeds into next input', async () => {
    // string_to_number converts "123" → 123, then auto_convert to string → "123"
    const configs: TransformerConfig[] = [
      { type: TransformerTypes.StringToNumber },
      { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } },
    ];
    const result = await applyTransformerPipeline(configs, '123', createBaseCtx());
    expect(result).toEqual({ success: true, value: '123' });
  });

  it('short-circuits on skip', async () => {
    const configs: TransformerConfig[] = [
      mockConfig('mock_skip'),
      { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } },
    ];
    const result = await applyTransformerPipeline(configs, 'test', createBaseCtx());
    expect(result).toEqual({ success: true, skip: true });
  });

  it('short-circuits on failure and includes failedTransformerType', async () => {
    const configs: TransformerConfig[] = [
      mockConfig('mock_passthrough'),
      mockConfig('mock_fail'),
      { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } },
    ];
    const result = await applyTransformerPipeline(configs, 'test', createBaseCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('mock failure');
      expect(result.failedTransformerType).toBe('mock_fail');
      expect(result.useOriginal).toBe(true);
    }
  });

  it('returns failure for unknown transformer type', async () => {
    const configs: TransformerConfig[] = [mockConfig('nonexistent_type')];
    const result = await applyTransformerPipeline(configs, 'test', createBaseCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Unknown transformer type');
      expect(result.failedTransformerType).toBe('nonexistent_type');
    }
  });

  it('passes the transformed value from step to step', async () => {
    const configs: TransformerConfig[] = [{ type: TransformerTypes.AutoConvert, options: { targetType: 'number' } }];
    const result = await applyTransformerPipeline(configs, '99', createBaseCtx());
    expect(result).toEqual({ success: true, value: 99 });
  });
});
