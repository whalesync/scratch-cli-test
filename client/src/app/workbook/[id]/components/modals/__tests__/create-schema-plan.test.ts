import { editorFieldFromSpec, toCreateFieldSpec } from '../create-schema-plan';

// DEV-11903: a generated plan's exact native column type describes the ORIGINAL column, so it rides along
// only while the field's logical type is exactly the one the plan generated it with.
describe('create-schema editor — nativeFieldType', () => {
  const pharmaciesDesiredSpec = {
    name: 'pharmacies_desired',
    fieldType: { kind: 'text' as const, isArray: true },
    nativeFieldType: { typeSystem: 'postgres', type: 'text[]' },
  };

  it('round-trips an untouched field with its native type and list flag', () => {
    expect(toCreateFieldSpec(editorFieldFromSpec(pharmaciesDesiredSpec))).toEqual(pharmaciesDesiredSpec);
  });

  it('drops the native type when "List of values" is unticked on the same kind', () => {
    const edited = { ...editorFieldFromSpec(pharmaciesDesiredSpec), isArray: false };
    expect(toCreateFieldSpec(edited)).toEqual({ name: 'pharmacies_desired', fieldType: { kind: 'text' } });
  });

  it('drops the native type when a number field changes format', () => {
    const integerSpec = {
      name: 'request_id_autonumber',
      fieldType: { kind: 'number' as const },
      nativeFieldType: { typeSystem: 'postgres', type: 'integer' },
    };
    expect(toCreateFieldSpec(editorFieldFromSpec(integerSpec))).toEqual(integerSpec);
    const edited = { ...editorFieldFromSpec(integerSpec), format: 'decimal' as const };
    expect(toCreateFieldSpec(edited).nativeFieldType).toBeUndefined();
  });

  it('drops the native type when the kind changes, and restores it if the edit is undone', () => {
    const field = editorFieldFromSpec(pharmaciesDesiredSpec);
    expect(toCreateFieldSpec({ ...field, kind: 'json' }).nativeFieldType).toBeUndefined();
    expect(toCreateFieldSpec({ ...field, kind: 'text' }).nativeFieldType).toEqual(
      pharmaciesDesiredSpec.nativeFieldType,
    );
  });
});
