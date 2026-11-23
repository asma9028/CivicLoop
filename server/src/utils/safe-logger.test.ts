import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignRequestId, createRequestLogger } from '../middleware/request-logging.js';
import { logSafeError } from './safe-logger.js';

describe('privacy-safe operational logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs route templates and operational metadata without request data', async () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const app = express();
    app.use(assignRequestId, createRequestLogger(stream), express.json());
    app.post('/records/:id', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/records/private-record-id?search=private-query-value`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-header-token',
          Cookie: 'private-cookie-value',
          'X-Request-Id': 'caller-controlled-id',
        },
        body: JSON.stringify({ description: 'private-body-value' }),
      });

      expect(response.status).toBe(200);
      const record = JSON.parse(output.trim()) as Record<string, unknown>;
      expect(record).toMatchObject({ method: 'POST', route: '/records/:id', status: 200 });
      expect(record.requestId).not.toBe('caller-controlled-id');
      expect(output).not.toMatch(/private-record-id|private-query-value|private-header-token|private-cookie-value|private-body-value|caller-controlled-id/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('omits raw exception messages from error logs', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logSafeError('auth.login', new Error('password=private-value'), 'request-123');

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0][0]);
    expect(output).toContain('"context":"auth.login"');
    expect(output).toContain('"requestId":"request-123"');
    expect(output).not.toContain('private-value');
  });
});
