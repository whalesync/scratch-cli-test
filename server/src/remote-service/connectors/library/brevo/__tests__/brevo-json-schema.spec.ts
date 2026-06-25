/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import {
  buildBrevoContactsJsonTableSpec,
  buildBrevoMailingListsJsonTableSpec,
  buildBrevoTemplatesJsonTableSpec,
} from '../brevo-json-schema';
import { BrevoContactAttribute } from '../brevo-types';

function makeAttribute(
  overrides: Partial<BrevoContactAttribute> & { type: BrevoContactAttribute['type'] },
): BrevoContactAttribute {
  return {
    name: overrides.name ?? 'TEST_ATTR',
    category: overrides.category ?? 'normal',
    type: overrides.type,
    enumeration: overrides.enumeration,
    multiCategoryOptions: overrides.multiCategoryOptions,
  };
}

describe('buildBrevoContactsJsonTableSpec', () => {
  const entityId = { wsId: 'contacts', remoteId: ['contacts'] };

  it('builds spec with correct metadata', () => {
    const spec = buildBrevoContactsJsonTableSpec(entityId, []);

    expect(spec.name).toBe('Contacts');
    expect(spec.slug).toBe('contacts');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('email');
    expect(spec.slugPath).toBe('email');
  });

  it('includes all system fields', () => {
    const spec = buildBrevoContactsJsonTableSpec(entityId, []);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('email');
    expect(props).toHaveProperty('emailBlacklisted');
    expect(props).toHaveProperty('smsBlacklisted');
    expect(props).toHaveProperty('listIds');
    expect(props).toHaveProperty('listUnsubscribed');
    expect(props).toHaveProperty('attributes');
    expect(props).toHaveProperty('createdAt');
    expect(props).toHaveProperty('modifiedAt');
  });

  it('marks id, listUnsubscribed, createdAt, modifiedAt as readonly', () => {
    const spec = buildBrevoContactsJsonTableSpec(entityId, []);
    const props = spec.schema.properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.listUnsubscribed[X_SCRATCH_READONLY]).toBe(true);
    expect(props.createdAt[X_SCRATCH_READONLY]).toBe(true);
    expect(props.modifiedAt[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does not mark email or emailBlacklisted as readonly', () => {
    const spec = buildBrevoContactsJsonTableSpec(entityId, []);
    const props = spec.schema.properties;

    expect(props.email[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.emailBlacklisted[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('adds text attributes as String | Null', () => {
    const attrs = [makeAttribute({ name: 'FIRSTNAME', type: 'text' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('FIRSTNAME');
    expect(attrProps.FIRSTNAME.anyOf).toHaveLength(2);
  });

  it('adds float attributes as Number | Null', () => {
    const attrs = [makeAttribute({ name: 'REVENUE', type: 'float' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('REVENUE');
    const numberType = attrProps.REVENUE.anyOf?.find((s: { type?: string }) => s.type === 'number');
    expect(numberType).toBeDefined();
  });

  it('adds date attributes as String(format: date-time) | Null', () => {
    const attrs = [makeAttribute({ name: 'BIRTHDAY', type: 'date' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('BIRTHDAY');
    const stringType = attrProps.BIRTHDAY.anyOf?.find((s: { type?: string }) => s.type === 'string');
    expect(stringType?.format).toBe('date-time');
  });

  it('adds boolean attributes as Boolean | Null', () => {
    const attrs = [makeAttribute({ name: 'OPT_IN', type: 'boolean' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('OPT_IN');
    const boolType = attrProps.OPT_IN.anyOf?.find((s: { type?: string }) => s.type === 'boolean');
    expect(boolType).toBeDefined();
  });

  it('adds id attributes as readonly Number | Null', () => {
    const attrs = [makeAttribute({ name: 'CONTACT_ID', type: 'id' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('CONTACT_ID');
    expect(attrProps.CONTACT_ID[X_SCRATCH_READONLY]).toBe(true);
  });

  it('adds multiple-choice attributes as String | Null', () => {
    const attrs = [makeAttribute({ name: 'SEGMENT', type: 'multiple-choice', multiCategoryOptions: ['A', 'B'] })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('SEGMENT');
    expect(attrProps.SEGMENT.anyOf).toHaveLength(2);
  });

  it('marks calculated attributes as readonly', () => {
    const attrs = [makeAttribute({ name: 'CALC_FIELD', type: 'float', category: 'calculated' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps.CALC_FIELD[X_SCRATCH_READONLY]).toBe(true);
  });

  it('marks global attributes as readonly', () => {
    const attrs = [makeAttribute({ name: 'GLOBAL_FIELD', type: 'text', category: 'global' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps.GLOBAL_FIELD[X_SCRATCH_READONLY]).toBe(true);
  });

  it('handles empty attributes array', () => {
    const spec = buildBrevoContactsJsonTableSpec(entityId, []);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toBeDefined();
    expect(Object.keys(attrProps)).toHaveLength(0);
  });

  it('preserves uppercase attribute names', () => {
    const attrs = [makeAttribute({ name: 'MY_CUSTOM_FIELD', type: 'text' })];
    const spec = buildBrevoContactsJsonTableSpec(entityId, attrs);
    const attrProps = spec.schema.properties.attributes.properties;

    expect(attrProps).toHaveProperty('MY_CUSTOM_FIELD');
    expect(attrProps).not.toHaveProperty('my_custom_field');
  });
});

describe('buildBrevoTemplatesJsonTableSpec', () => {
  const entityId = { wsId: 'templates', remoteId: ['templates'] };

  it('builds spec with correct metadata', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);

    expect(spec.name).toBe('Email Templates');
    expect(spec.slug).toBe('templates');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('name');
    expect(spec.slugPath).toBe('name');
  });

  it('includes all template fields', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('subject');
    expect(props).toHaveProperty('htmlContent');
    expect(props).toHaveProperty('isActive');
    expect(props).toHaveProperty('testSent');
    expect(props).toHaveProperty('sender');
    expect(props).toHaveProperty('replyTo');
    expect(props).toHaveProperty('toField');
    expect(props).toHaveProperty('tag');
    expect(props).toHaveProperty('createdAt');
    expect(props).toHaveProperty('modifiedAt');
  });

  it('marks id, testSent, createdAt, modifiedAt as readonly', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.testSent[X_SCRATCH_READONLY]).toBe(true);
    expect(props.createdAt[X_SCRATCH_READONLY]).toBe(true);
    expect(props.modifiedAt[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does not mark name, subject, htmlContent as readonly', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.name[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.subject[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.htmlContent[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('tags htmlContent with contentMediaType: text/html', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.htmlContent.contentMediaType).toBe('text/html');
  });

  it('includes sender as an object with name, email, id subfields', () => {
    const spec = buildBrevoTemplatesJsonTableSpec(entityId);
    const sender = spec.schema.properties.sender;

    expect(sender.type).toBe('object');
    expect(sender.properties).toHaveProperty('name');
    expect(sender.properties).toHaveProperty('email');
    expect(sender.properties).toHaveProperty('id');
  });
});

describe('buildBrevoMailingListsJsonTableSpec', () => {
  const entityId = { wsId: 'mailing_lists', remoteId: ['mailing_lists'] };

  it('builds spec with correct metadata', () => {
    const spec = buildBrevoMailingListsJsonTableSpec(entityId);

    expect(spec.name).toBe('Mailing Lists');
    expect(spec.slug).toBe('mailing_lists');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('name');
    expect(spec.slugPath).toBe('name');
  });

  it('includes all mailing list fields', () => {
    const spec = buildBrevoMailingListsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('totalSubscribers');
    expect(props).toHaveProperty('uniqueSubscribers');
    expect(props).toHaveProperty('totalBlacklisted');
    expect(props).toHaveProperty('folderId');
    expect(props).toHaveProperty('dynamicList');
    expect(props).toHaveProperty('createdAt');
  });

  it('marks all fields as readonly', () => {
    const spec = buildBrevoMailingListsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    for (const key of Object.keys(props)) {
      expect(props[key][X_SCRATCH_READONLY]).toBe(true);
    }
  });
});
