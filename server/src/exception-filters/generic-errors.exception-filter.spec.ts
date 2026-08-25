import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { WSLogger } from 'src/logger';
import { NotFoundExceptionFilter } from './generic-errors.exception-filter';

function mockHost({
  method = 'GET',
  url = '/x',
}: {
  method?: string;
  url?: string;
} = {}): { host: ArgumentsHost; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method, url };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('NotFoundExceptionFilter', () => {
  const filter = new NotFoundExceptionFilter();

  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs an unmatched-route 404 (NestJS "Cannot GET ..." scanner probe) at WARN, not ERROR', () => {
    const { host, status, json } = mockHost({ method: 'GET', url: '/wp-login.php' });

    filter.catch(new NotFoundException('Cannot GET /wp-login.php'), host);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ExceptionFilters',
        message: 'Caught NotFoundException',
        error: 'Cannot GET /wp-login.php',
        method: 'GET',
        path: '/wp-login.php',
      }),
    );

    // Response is still a normal 404 regardless of log level.
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalled();
  });

  it('logs a deliberately app-thrown 404 at ERROR', () => {
    const { host, status } = mockHost({ method: 'GET', url: '/workbooks/wb_1' });

    filter.catch(new NotFoundException('Workbook not found'), host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ExceptionFilters',
        message: 'Caught NotFoundException',
        error: 'Workbook not found',
      }),
    );
    expect(status).toHaveBeenCalledWith(404);
  });
});
