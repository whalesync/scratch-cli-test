import { TRANSFORMER_TYPES } from '@spinner/shared-types';
import '..'; // Trigger auto-registration of all transformers via the index
import { getAllTransformerMetadata, getRegisteredTransformerTypes } from '../transformer-registry';

describe('transformer metadata', () => {
  const metadata = getAllTransformerMetadata();

  it('should return metadata for every type in TRANSFORMER_TYPES', () => {
    const metadataTypes = metadata.map((m) => m.type);
    const expectedTypes = TRANSFORMER_TYPES.map((t) => t.type);
    expect(metadataTypes).toEqual(expectedTypes);
  });

  it('should have metadata for every registered transformer', () => {
    const registeredTypes = getRegisteredTransformerTypes();
    const metadataTypes = new Set(metadata.map((m) => m.type));
    for (const type of registeredTypes) {
      expect(metadataTypes.has(type)).toBe(true);
    }
  });

  it('should have valid structure for every metadata entry', () => {
    for (const entry of metadata) {
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.fields)).toBe(true);
      expect(typeof entry.defaultOptions).toBe('object');
    }
  });

  it('should have valid field descriptors', () => {
    const validWidgets = new Set(['select', 'checkbox', 'text', 'folder_picker', 'json_editor', 'transformer_config']);

    for (const entry of metadata) {
      for (const field of entry.fields) {
        expect(typeof field.key).toBe('string');
        expect(field.key.length).toBeGreaterThan(0);
        expect(validWidgets.has(field.widget)).toBe(true);
        expect(typeof field.label).toBe('string');

        if (field.widget === 'select') {
          expect(Array.isArray(field.selectOptions)).toBe(true);
          expect(field.selectOptions!.length).toBeGreaterThan(0);
          for (const opt of field.selectOptions!) {
            expect(typeof opt.value).toBe('string');
            expect(typeof opt.label).toBe('string');
          }
        }

        if (field.visibleWhen) {
          expect(typeof field.visibleWhen.field).toBe('string');
          // The referenced field should exist in the same transformer's fields
          const siblingKeys = entry.fields.map((f) => f.key);
          expect(siblingKeys).toContain(field.visibleWhen.field);
        }
      }
    }
  });

  it('should compute defaultOptions from field defaultValues', () => {
    for (const entry of metadata) {
      for (const field of entry.fields) {
        if (field.defaultValue !== undefined) {
          expect(entry.defaultOptions[field.key]).toEqual(field.defaultValue);
        }
      }
    }
  });

  it('should have required fields included in defaultOptions', () => {
    for (const entry of metadata) {
      for (const field of entry.fields) {
        if (field.required) {
          expect(field.defaultValue).toBeDefined();
          expect(entry.defaultOptions).toHaveProperty(field.key);
        }
      }
    }
  });

  it('should have optionsSchema defined on every registered transformer', () => {
    // This ensures no transformer is missing its schema
    for (const entry of metadata) {
      expect(entry.fields).toBeDefined();
    }
  });
});
