import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../config/prisma.js', () => ({ prisma: prismaMock }));

import { consumeAiConsent, issueAiConsent, type AiConsentContext } from './consent.js';

const incidentContext: AiConsentContext = {
  userId: 'citizen-1',
  purpose: 'INCIDENT_CLASSIFICATION',
  operation: 'INCIDENT_PREVIEW',
  subject: {
    title: 'Large pothole on main road',
    description: 'A deep pothole is creating a dangerous hazard for road users.',
  },
};

describe('server-issued AI consent grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('JWT_SECRET', 'unit-test-session-secret');
    prismaMock.$executeRaw.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('allows one matching use and rejects replay', async () => {
    const token = await issueAiConsent(incidentContext);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ tokenId: 'grant-1' }])
      .mockResolvedValueOnce([]);

    expect(await consumeAiConsent(token, incidentContext)).toBe(true);
    expect(await consumeAiConsent(token, incidentContext)).toBe(false);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects grants for another user, purpose, operation, or report text', async () => {
    const token = await issueAiConsent(incidentContext);
    const changedSubject = {
      ...incidentContext,
      subject: {
        title: 'Different incident title',
        description: 'A deep pothole is creating a dangerous hazard for road users.',
      },
    };

    expect(await consumeAiConsent(token, { ...incidentContext, userId: 'citizen-2' })).toBe(false);
    expect(await consumeAiConsent(token, { ...incidentContext, purpose: 'VERIFICATION_ANALYSIS' })).toBe(false);
    expect(await consumeAiConsent(token, { ...incidentContext, operation: 'INCIDENT_SUBMISSION' })).toBe(false);
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    expect(await consumeAiConsent(token, changedSubject)).toBe(false);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects expired grants before attempting database consumption', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const token = await issueAiConsent(incidentContext);

    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(await consumeAiConsent(token, incidentContext)).toBe(false);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
