import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createReadinessHandler } from './health.js';

function mockResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe('database readiness handler', () => {
  it('reports ready when the dependency check succeeds', async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);
    const response = mockResponse();

    await createReadinessHandler(checkDatabase)({} as Request, response as unknown as Response);

    expect(checkDatabase).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('returns a generic unavailable response without exposing dependency errors', async () => {
    const checkDatabase = vi.fn().mockRejectedValue(new Error('database host and credentials must stay private'));
    const response = mockResponse();

    await createReadinessHandler(checkDatabase)({} as Request, response as unknown as Response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ status: 'not_ready' });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('credentials');
  });
});
