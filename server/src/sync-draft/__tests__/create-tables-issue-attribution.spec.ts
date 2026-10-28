import { BadRequestException } from '@nestjs/common';
import type { CreateFieldSpec, CreateTableSpec } from '@spinner/shared-types';
import {
  findTablesLinkingToUncreatableTables,
  groupCreateSchemaIssuesByTableIndex,
} from '../create-tables-issue-attribution';

const tooManyFieldsIssue = (tableIndex: number) => ({
  path: `tables[${tableIndex}].fields`,
  code: 'TOO_MANY_FIELDS',
  message: "this table has 186 fields, which exceeds the connector's maximum of 180 fields per table",
});

describe('groupCreateSchemaIssuesByTableIndex', () => {
  it('groups create-schema issues by the table index their path starts with', () => {
    const nameIssue = { path: 'tables[1].fields[2].name', code: 'FIELD_NAME_TOO_LONG', message: 'too long' };
    const error = new BadRequestException({
      message: 'create-schema validation failed',
      issues: [tooManyFieldsIssue(1), nameIssue, tooManyFieldsIssue(3)],
    });

    expect(groupCreateSchemaIssuesByTableIndex(error)).toEqual(
      new Map([
        [1, [tooManyFieldsIssue(1), nameIssue]],
        [3, [tooManyFieldsIssue(3)]],
      ]),
    );
  });

  it('returns null when any issue names no table, so the caller fails the whole batch', () => {
    const error = new BadRequestException({
      message: 'create-schema validation failed',
      issues: [tooManyFieldsIssue(0), { path: 'fields[0].name', code: 'FIELD_NAME_ALREADY_EXISTS', message: 'x' }],
    });

    expect(groupCreateSchemaIssuesByTableIndex(error)).toBeNull();
  });

  it('returns null for an error that is not a structured create-schema validation error', () => {
    expect(groupCreateSchemaIssuesByTableIndex(new Error('connection reset'))).toBeNull();
    expect(groupCreateSchemaIssuesByTableIndex(new BadRequestException('plain message'))).toBeNull();
    expect(
      groupCreateSchemaIssuesByTableIndex(
        new BadRequestException({ message: 'create-schema validation failed', issues: [] }),
      ),
    ).toBeNull();
  });
});

describe('findTablesLinkingToUncreatableTables', () => {
  const textField = (name: string): CreateFieldSpec => ({ name, fieldType: { kind: 'text' } });
  const linkTo = (name: string, targetRef: string): CreateFieldSpec => ({
    name,
    fieldType: { kind: 'foreignKey', target: { ref: targetRef } },
  });
  const table = (ref: string, fields: CreateFieldSpec[]): CreateTableSpec => ({ ref, name: `${ref} table`, fields });

  it('finds tables linking to an uncreatable table, directly or through another one', () => {
    const tables = [
      table('wide', [textField('A')]),
      table('contacts', [textField('Name'), linkTo('Wide', 'wide')]),
      table('deals', [linkTo('Contact', 'contacts')]),
      table('notes', [textField('Body')]),
    ];

    expect(findTablesLinkingToUncreatableTables(tables, new Set(['wide']))).toEqual(
      new Map([
        [1, 'wide table'],
        [2, 'contacts table'],
      ]),
    );
  });

  it("ignores a table's link to itself and links to tables outside the batch", () => {
    const tables = [
      table('wide', [textField('A')]),
      table('employees', [linkTo('Manager', 'employees')]),
      table('orders', [
        { name: 'Customer', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['tblC'] } } },
      ]),
    ];

    expect(findTablesLinkingToUncreatableTables(tables, new Set(['wide']))).toEqual(new Map());
  });
});
