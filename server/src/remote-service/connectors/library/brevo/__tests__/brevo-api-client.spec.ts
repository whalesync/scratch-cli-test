import axios from 'axios';
import { BrevoApiClient, BrevoError } from '../brevo-api-client';

// Mock create-api-client to return a mock axios instance
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
  })),
}));

describe('BrevoApiClient', () => {
  let client: BrevoApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new BrevoApiClient('test-api-key');
  });

  // ---------------------------------------------------------------------------
  // validateCredentials
  // ---------------------------------------------------------------------------

  describe('validateCredentials', () => {
    it('succeeds when API returns 200', async () => {
      mockGet.mockResolvedValue({ data: { contacts: [], count: 0 } });

      await expect(client.validateCredentials()).resolves.toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/contacts', { params: { limit: 1, offset: 0 } });
    });

    it('throws BrevoError on 401', async () => {
      const error = new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: { message: 'Invalid API key' },
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow(BrevoError);
      await expect(client.validateCredentials()).rejects.toThrow('Invalid API key');
    });

    it('rethrows non-401 errors', async () => {
      const error = new Error('Network error');
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow('Network error');
    });
  });

  // ---------------------------------------------------------------------------
  // listContacts
  // ---------------------------------------------------------------------------

  describe('listContacts', () => {
    it('yields pages of contacts', async () => {
      const page1 = [
        { id: 1, email: 'a@test.com' },
        { id: 2, email: 'b@test.com' },
      ];
      const page2 = [{ id: 3, email: 'c@test.com' }];

      mockGet
        .mockResolvedValueOnce({ data: { contacts: page1, count: 3 } })
        .mockResolvedValueOnce({ data: { contacts: page2, count: 3 } });

      const pages: unknown[][] = [];
      for await (const page of client.listContacts(2)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(2);
      expect(pages[1]).toHaveLength(1);
    });

    it('stops when offset reaches total count', async () => {
      mockGet.mockResolvedValueOnce({ data: { contacts: [{ id: 1 }], count: 1 } });

      const pages: unknown[][] = [];
      for await (const page of client.listContacts(1000)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('handles empty result', async () => {
      mockGet.mockResolvedValueOnce({ data: { contacts: [], count: 0 } });

      const pages: unknown[][] = [];
      for await (const page of client.listContacts()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getContact
  // ---------------------------------------------------------------------------

  describe('getContact', () => {
    it('returns contact by email', async () => {
      const contact = { id: 1, email: 'test@example.com' };
      mockGet.mockResolvedValue({ data: contact });

      const result = await client.getContact('test@example.com');

      expect(result).toEqual(contact);
      expect(mockGet).toHaveBeenCalledWith(`/contacts/${encodeURIComponent('test@example.com')}`);
    });

    it('returns contact by numeric ID', async () => {
      const contact = { id: 42, email: 'test@example.com' };
      mockGet.mockResolvedValue({ data: contact });

      const result = await client.getContact(42);

      expect(result).toEqual(contact);
      expect(mockGet).toHaveBeenCalledWith('/contacts/42');
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getContact('missing@example.com');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // createContact
  // ---------------------------------------------------------------------------

  describe('createContact', () => {
    it('creates and returns full contact via follow-up GET', async () => {
      const fullContact = { id: 99, email: 'new@example.com', attributes: {} };
      mockPost.mockResolvedValue({ data: { id: 99 } });
      mockGet.mockResolvedValue({ data: fullContact });

      const result = await client.createContact({ email: 'new@example.com' });

      expect(result).toEqual(fullContact);
      expect(mockPost).toHaveBeenCalledWith('/contacts', { email: 'new@example.com' });
      expect(mockGet).toHaveBeenCalledWith('/contacts/99');
    });

    it('throws if follow-up GET returns null', async () => {
      mockPost.mockResolvedValue({ data: { id: 99 } });
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.createContact({ email: 'ghost@example.com' })).rejects.toThrow('could not be retrieved');
    });
  });

  // ---------------------------------------------------------------------------
  // updateContact
  // ---------------------------------------------------------------------------

  describe('updateContact', () => {
    it('sends PUT with identifier and data', async () => {
      mockPut.mockResolvedValue({ status: 204 });

      await client.updateContact(42, { attributes: { FIRSTNAME: 'Jane' } });

      expect(mockPut).toHaveBeenCalledWith('/contacts/42', { attributes: { FIRSTNAME: 'Jane' } });
    });

    it('encodes email identifiers', async () => {
      mockPut.mockResolvedValue({ status: 204 });

      await client.updateContact('user+tag@example.com', { emailBlacklisted: false });

      expect(mockPut).toHaveBeenCalledWith(`/contacts/${encodeURIComponent('user+tag@example.com')}`, {
        emailBlacklisted: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteContact
  // ---------------------------------------------------------------------------

  describe('deleteContact', () => {
    it('sends DELETE with identifier', async () => {
      mockDelete.mockResolvedValue({ status: 204 });

      await client.deleteContact(42);

      expect(mockDelete).toHaveBeenCalledWith('/contacts/42');
    });

    it('swallows 404 errors', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteContact(999)).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      const error = new axios.AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        data: {},
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteContact(42)).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // getContactAttributes
  // ---------------------------------------------------------------------------

  describe('getContactAttributes', () => {
    it('returns attribute definitions', async () => {
      const attrs = [
        { name: 'FIRSTNAME', category: 'normal', type: 'text' },
        { name: 'REVENUE', category: 'normal', type: 'float' },
      ];
      mockGet.mockResolvedValue({ data: { attributes: attrs } });

      const result = await client.getContactAttributes();

      expect(result).toEqual(attrs);
      expect(mockGet).toHaveBeenCalledWith('/contacts/attributes');
    });
  });

  // ---------------------------------------------------------------------------
  // listTemplates
  // ---------------------------------------------------------------------------

  describe('listTemplates', () => {
    it('yields pages of templates', async () => {
      const templates = [{ id: 1, name: 'Template 1' }];
      mockGet.mockResolvedValueOnce({ data: { templates, count: 1 } });

      const pages: unknown[][] = [];
      for await (const page of client.listTemplates()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0]).toEqual(templates);
    });

    it('handles zero templates', async () => {
      mockGet.mockResolvedValueOnce({ data: { templates: [], count: 0 } });

      const pages: unknown[][] = [];
      for await (const page of client.listTemplates()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getTemplate
  // ---------------------------------------------------------------------------

  describe('getTemplate', () => {
    it('returns template by ID', async () => {
      const template = { id: 5, name: 'Welcome', htmlContent: '<h1>Hi</h1>' };
      mockGet.mockResolvedValue({ data: template });

      const result = await client.getTemplate(5);

      expect(result).toEqual(template);
      expect(mockGet).toHaveBeenCalledWith('/smtp/templates/5');
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getTemplate(999);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // createTemplate
  // ---------------------------------------------------------------------------

  describe('createTemplate', () => {
    it('creates and returns full template via follow-up GET', async () => {
      const fullTemplate = { id: 10, name: 'New', htmlContent: '<p>Hi</p>' };
      mockPost.mockResolvedValue({ data: { id: 10 } });
      mockGet.mockResolvedValue({ data: fullTemplate });

      const result = await client.createTemplate({
        templateName: 'New',
        subject: 'Hello',
        sender: { email: 'sender@example.com' },
      });

      expect(result).toEqual(fullTemplate);
      expect(mockPost).toHaveBeenCalledWith('/smtp/templates', expect.objectContaining({ templateName: 'New' }));
    });
  });

  // ---------------------------------------------------------------------------
  // updateTemplate
  // ---------------------------------------------------------------------------

  describe('updateTemplate', () => {
    it('sends PUT with template ID and data', async () => {
      mockPut.mockResolvedValue({ status: 204 });

      await client.updateTemplate(10, { templateName: 'Updated', subject: 'New Subject' });

      expect(mockPut).toHaveBeenCalledWith('/smtp/templates/10', { templateName: 'Updated', subject: 'New Subject' });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteTemplate
  // ---------------------------------------------------------------------------

  describe('deleteTemplate', () => {
    it('sends DELETE with template ID', async () => {
      mockDelete.mockResolvedValue({ status: 204 });

      await client.deleteTemplate(10);

      expect(mockDelete).toHaveBeenCalledWith('/smtp/templates/10');
    });

    it('swallows 404 errors', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteTemplate(999)).resolves.toBeUndefined();
    });
  });
});
