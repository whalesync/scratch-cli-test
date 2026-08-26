/**
 * Regression tests for the hardened API client in `common.ts`.
 *
 * A single dropped connection between a CI runner and test-api repeatedly turned healthy
 * post-deploy runs red: a bare `axios` call has no timeout, so the dead socket hung until Jest's
 * 60s cap fired. These lock down that a transient transport failure is retried, that a write is
 * never replayed once the server may have received it, and that real API errors still surface.
 *
 * Fully self-contained — it drives a local `http` server and needs no database, no external
 * network, and no environment configuration.
 */
import { AxiosError } from 'axios';
import * as http from 'http';
import { AddressInfo } from 'net';

import { createScratchApiClient } from './common';

describe('createScratchApiClient', () => {
  let server: http.Server;
  let baseUrl: string;
  let handledRequestCount: number;
  let handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => void;

  beforeEach(async () => {
    handledRequestCount = 0;
    server = http.createServer((request, response) => {
      handledRequestCount += 1;
      handleRequest(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Kill the connection without replying, the way a dropped socket behaves. */
  const destroyConnection = (request: http.IncomingMessage) => request.socket.destroy();

  const respondOk = (response: http.ServerResponse, body: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  it('retries a read whose connection drops, and returns the eventual response', async () => {
    handleRequest = (request, response) => {
      if (handledRequestCount === 1) {
        destroyConnection(request);
        return;
      }
      respondOk(response, { ok: true });
    };

    const response = await createScratchApiClient().get(`${baseUrl}/users/current`);

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(handledRequestCount).toBe(2);
  });

  it('does NOT replay a write once the server may have received it', async () => {
    // The server got the request and then the connection died, so we cannot know whether it was
    // applied. Replaying could duplicate the write, so the failure must surface instead.
    handleRequest = (request) => destroyConnection(request);

    await expect(createScratchApiClient().post(`${baseUrl}/internal/whalesync/sessions`, {})).rejects.toThrow();

    expect(handledRequestCount).toBe(1);
  });

  it('surfaces a real API error instead of retrying it', async () => {
    // Only transport failures are retried. A response — any response — is the API's answer and
    // must reach the assertion untouched, so a flaky-looking 503 is never masked into a success.
    handleRequest = (_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ statusCode: 503, status: 'check_failed' }));
    };

    const error: AxiosError = await createScratchApiClient()
      .get(`${baseUrl}/users/current`)
      .then(() => {
        throw new Error('expected the 503 to reject');
      })
      .catch((caught: AxiosError) => caught);

    expect(error.response?.status).toBe(503);
    expect(handledRequestCount).toBe(1);
  });

  it('gives up on a stalled attempt rather than hanging until the Jest timeout', () => {
    // The bound that makes a retry possible at all: without it a dead socket hangs the test.
    expect(createScratchApiClient().defaults.timeout).toBeGreaterThan(0);
  });
});
