import type { AddressInfo } from 'node:net';
import express, { type Request, type Response, type NextFunction } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    civicNotification: {
      findMany: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
    },
    incidentSupport: { findMany: vi.fn() },
    followedArea: { findMany: vi.fn() },
    campaignParticipant: { findMany: vi.fn() },
    verificationCase: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    verificationAction: { create: vi.fn() },
    incidentActivity: { create: vi.fn() },
  },
}));

vi.mock('../config/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../middleware/auth.js', () => ({
  optionalAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { communityRouter } from './community.js';
import { verificationRouter } from './verification.js';

async function requestRouter(router: express.Router, route: string, method = 'GET') {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'citizen-1', role: 'CITIZEN', fullName: 'Test Citizen', email: 'test@example.com' } });
    next();
  });
  app.use(router);
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${address.port}${route}`, { method });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('read-only GET endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      Array.isArray(operations) ? Promise.all(operations) : operations(prismaMock));
    prismaMock.civicNotification.findMany.mockResolvedValue([]);
    prismaMock.civicNotification.count.mockResolvedValue(0);
    prismaMock.incidentSupport.findMany.mockResolvedValue([]);
    prismaMock.followedArea.findMany.mockResolvedValue([]);
    prismaMock.campaignParticipant.findMany.mockResolvedValue([]);
    prismaMock.verificationCase.findMany.mockResolvedValue([]);
    prismaMock.verificationCase.count.mockResolvedValue(0);
    prismaMock.verificationCase.updateMany.mockResolvedValue({ count: 0 });
  });

  it('does not materialize notifications while reading the notification inbox', async () => {
    const response = await requestRouter(communityRouter, '/notifications?limit=10');

    expect(response.status).toBe(200);
    expect(prismaMock.civicNotification.createMany).not.toHaveBeenCalled();
  });

  it('does not escalate deadlines while reading a citizen verification list', async () => {
    const response = await requestRouter(verificationRouter, '/me?limit=10');

    expect(response.status).toBe(200);
    expect(prismaMock.verificationCase.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.verificationAction.create).not.toHaveBeenCalled();
    expect(prismaMock.incidentActivity.create).not.toHaveBeenCalled();
  });

  it('rejects verification AI analysis requests without a consent capability', async () => {
    const response = await requestRouter(verificationRouter, '/cases/case-1/analyze', 'POST');

    expect(response.status).toBe(403);
    expect(prismaMock.verificationCase.findUnique).not.toHaveBeenCalled();
  });

  it('rejects public community filtering by stored address text', async () => {
    const response = await requestRouter(communityRouter, '/incidents?location=17%20Juniper%20Road');

    expect(response.status).toBe(400);
    expect(prismaMock.incidentSupport.findMany).not.toHaveBeenCalled();
  });

  it('materializes notifications only through the explicit idempotent POST operation', async () => {
    prismaMock.incidentSupport.findMany.mockResolvedValue([{
      incident: {
        id: 'incident-1',
        activities: [{ id: 'activity-1', createdAt: new Date('2026-03-01T12:00:00Z'), newStatus: 'IN_PROGRESS' }],
      },
      supportedAt: new Date('2026-02-28T12:00:00Z'),
    }]);
    prismaMock.civicNotification.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const first = await requestRouter(communityRouter, '/notifications/materialize', 'POST');
    const second = await requestRouter(communityRouter, '/notifications/materialize', 'POST');

    expect(await first.json()).toEqual({ created: 1 });
    expect(await second.json()).toEqual({ created: 0 });
    expect(prismaMock.civicNotification.createMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.civicNotification.createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    expect(prismaMock.civicNotification.createMany.mock.calls[0][0].data[0].sourceKey)
      .toBe(prismaMock.civicNotification.createMany.mock.calls[1][0].data[0].sourceKey);
  });

  it('uses a conditional update and writes one escalation for concurrent deadline processing', async () => {
    const candidate = { id: 'case-1', incidentId: 'incident-1', status: 'PENDING' };
    prismaMock.verificationCase.findMany.mockResolvedValue([candidate]);
    prismaMock.verificationCase.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const responses = await Promise.all([
      requestRouter(verificationRouter, '/process-deadlines', 'POST'),
      requestRouter(verificationRouter, '/process-deadlines', 'POST'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(prismaMock.verificationCase.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.verificationAction.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.incidentActivity.create).toHaveBeenCalledTimes(1);
  });
});
