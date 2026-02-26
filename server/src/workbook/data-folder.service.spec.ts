import type { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { DataFolderService } from './data-folder.service';

describe('DataFolderService.buildConnectorFolderPath', () => {
  let service: DataFolderService;

  beforeEach(() => {
    // buildConnectorFolderPath is a pure function that doesn't use any injected dependencies
    service = Object.create(DataFolderService.prototype) as DataFolderService;
  });

  const makeTableSpec = (overrides: Partial<BaseJsonTableSpec> = {}): BaseJsonTableSpec => ({
    id: 'table-1',
    slug: 'table-slug',
    name: 'My Table',
    schema: {} as TSchema,
    idColumnRemoteId: 'id',
    ...overrides,
  });

  it('should build path from connector display name and table name', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }));
    expect(result).toBe('/My Airtable/Products');
  });

  it('should include basePath segments between connector name and table name', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
    );
    expect(result).toBe('/My Airtable/Base One/Products');
  });

  it('should include multiple basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Webflow',
      makeTableSpec({ name: 'Blog Posts', basePath: ['My Site', 'CMS'] }),
    );
    expect(result).toBe('/Webflow/My Site/CMS/Blog Posts');
  });

  it('should prepend parentFolderPath when provided', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }), '/Parent');
    expect(result).toBe('/Parent/My Airtable/Products');
  });

  it('should handle parentFolderPath with basePath', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
      '/Parent/Sub',
    );
    expect(result).toBe('/Parent/Sub/My Airtable/Base One/Products');
  });

  it('should replace slashes with spaces in connector display name', () => {
    const result = service.buildConnectorFolderPath('My/Airtable', makeTableSpec({ name: 'Products' }));
    expect(result).toBe('/My Airtable/Products');
  });

  it('should replace slashes with spaces in table name', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Products/Items' }));
    expect(result).toBe('/Airtable/Products Items');
  });

  it('should replace slashes with spaces in basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base/One'] }),
    );
    expect(result).toBe('/Airtable/Base One/Table');
  });

  it('should replace asterisks and question marks with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'What*is*this?' }));
    expect(result).toBe('/Airtable/What is this');
  });

  it('should replace double quotes with spaces and collapse consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'The "Best" Table' }));
    expect(result).toBe('/Airtable/The Best Table');
  });

  it('should replace angle brackets and pipes with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '<Input|Output>' }));
    expect(result).toBe('/Airtable/Input Output');
  });

  it('should convert tabs to spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Tab\there' }));
    expect(result).toBe('/Airtable/Tab here');
  });

  it('should collapse multiple consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Too   many    spaces' }));
    expect(result).toBe('/Airtable/Too many spaces');
  });

  it('should trim leading and trailing whitespace from segments', () => {
    const result = service.buildConnectorFolderPath('  Airtable  ', makeTableSpec({ name: '  Products  ' }));
    expect(result).toBe('/Airtable/Products');
  });

  it('should trim trailing dots but preserve leading dots', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '..hidden.' }));
    expect(result).toBe('/Airtable/..hidden');
  });

  it('should filter out falsy basePath entries', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base', '', 'Sub'] }),
    );
    expect(result).toBe('/Airtable/Base/Sub/Table');
  });

  it('should handle empty basePath array', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: [] }));
    expect(result).toBe('/Airtable/Table');
  });

  it('should handle undefined basePath', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: undefined }));
    expect(result).toBe('/Airtable/Table');
  });
});
