import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, serviceMocks, txMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    incidentUpload: { findMany: vi.fn() },
    incident: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    department: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  serviceMocks: {
    classifyIncident: vi.fn(),
    ruleBasedClassification: vi.fn(),
    recommendDepartment: vi.fn(),
    findPotentialDuplicates: vi.fn(),
    calculatePriority: vi.fn(),
  },
  txMock: {
    incident: { create: vi.fn() },
    incidentActivity: { create: vi.fn() },
    incidentUpload: { updateMany: vi.fn() },
  },
}));

vi.mock('../config/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  optionalAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../services/ai/classifier.js', () => serviceMocks);
vi.mock('../services/ai/departments.js', () => ({ recommendDepartment: serviceMocks.recommendDepartment }));
vi.mock('../services/ai/duplicates.js', () => ({ findPotentialDuplicates: serviceMocks.findPotentialDuplicates }));
vi.mock('../services/ai/priority.js', () => ({ calculatePriority: serviceMocks.calculatePriority }));

import { incidentsRouter } from './incidents.js';
import { issueAiConsent } from '../services/ai/consent.js';

async function requestIncident(route: string, method: string, body?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'citizen-1', role: 'CITIZEN' } });
    next();
  });
  app.use('/api/incidents', incidentsRouter);

  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('citizen report AI opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('JWT_SECRET', 'unit-test-session-secret');
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$queryRaw.mockResolvedValue([]);
    serviceMocks.ruleBasedClassification.mockReturnValue({
      category: 'ROAD',
      subcategory: 'pothole',
      summary: 'A deep pothole blocks the road.',
      severity: 'MEDIUM',
      confidence: 0.68,
      reasoning: 'Road-related issue.',
      safetyRisk: 40,
      publicImpact: 30,
      timeSensitivity: 45,
      source: 'rules',
    });
    serviceMocks.classifyIncident.mockImplementation((input) => Promise.resolve(serviceMocks.ruleBasedClassification(input)));
    serviceMocks.recommendDepartment.mockResolvedValue({
      id: 'department-1',
      name: 'Public Works',
      confidence: 0.68,
    });
    serviceMocks.findPotentialDuplicates.mockResolvedValue([]);
    serviceMocks.calculatePriority.mockReturnValue({
      score: 42,
      band: 'NORMAL',
      breakdown: {},
    });
    txMock.incident.create.mockResolvedValue({
      id: 'incident-1',
      title: 'Large pothole on main road',
      category: 'ROAD',
      status: 'REPORTED',
      priorityScore: 42,
      priorityBand: 'NORMAL',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      department: { id: 'department-1', name: 'Public Works', code: 'PW' },
      duplicateOfIncidentId: null,
    });
    txMock.incidentActivity.create.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation((operation: Promise<unknown>[] | ((tx: typeof txMock) => Promise<unknown>)) =>
      Array.isArray(operation) ? Promise.all(operation) : operation(txMock));
    prismaMock.incident.findMany.mockResolvedValue([]);
    prismaMock.incident.count.mockResolvedValue(0);
    prismaMock.incident.groupBy.mockResolvedValue([]);
    prismaMock.department.groupBy.mockResolvedValue([]);
    prismaMock.department.findMany.mockResolvedValue([]);
    prismaMock.incidentUpload.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('submits a report with local rules and no Gemini request when AI is not opted into', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await requestIncident('/api/incidents', 'POST', {
      title: 'Large pothole on main road',
      description: 'A deep pothole is creating a dangerous hazard for road users.',
      category: 'ROAD',
      locationText: 'Main Road',
      latitude: 28.6139,
      longitude: 77.209,
      imageUrls: [],
      isPublic: true,
    });

    expect(response.status).toBe(201);
    expect(serviceMocks.classifyIncident).not.toHaveBeenCalled();
    expect(serviceMocks.ruleBasedClassification).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('generativelanguage.googleapis.com'))).toBe(false);
    expect(txMock.incident.create.mock.calls[0][0].data.aiProvider).toBe('rules');
  });

  it('rejects direct AI opt-in without a server-issued consent grant', async () => {
    const response = await requestIncident('/api/incidents/analyze', 'POST', {
      title: 'Large pothole on main road',
      description: 'A deep pothole is creating a dangerous hazard for road users.',
      useAiAnalysis: true,
    });

    expect(response.status).toBe(403);
    expect(serviceMocks.classifyIncident).not.toHaveBeenCalled();
  });

  it('runs report analysis only with a matching, one-time server grant', async () => {
    const title = 'Large pothole on main road';
    const description = 'A deep pothole is creating a dangerous hazard for road users.';
    const consentToken = await issueAiConsent({
      userId: 'citizen-1',
      purpose: 'INCIDENT_CLASSIFICATION',
      operation: 'INCIDENT_PREVIEW',
      subject: { title, description },
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([{ tokenId: 'grant-1' }]).mockResolvedValueOnce([]);
    const body = { title, description, useAiAnalysis: true, aiConsentToken: consentToken };

    const first = await requestIncident('/api/incidents/analyze', 'POST', body);
    const replay = await requestIncident('/api/incidents/analyze', 'POST', body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(serviceMocks.classifyIncident).toHaveBeenCalledTimes(1);
    expect(serviceMocks.classifyIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title, description }),
      { allowExternalAI: true },
    );
  });

  it('requires a submission-specific grant before AI is used to create a report', async () => {
    const title = 'Large pothole on main road';
    const description = 'A deep pothole is creating a dangerous hazard for road users.';
    const consentToken = await issueAiConsent({
      userId: 'citizen-1',
      purpose: 'INCIDENT_CLASSIFICATION',
      operation: 'INCIDENT_SUBMISSION',
      subject: { title, description },
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([{ tokenId: 'grant-2' }]);

    const response = await requestIncident('/api/incidents', 'POST', {
      title,
      description,
      category: 'ROAD',
      locationText: 'Main Road',
      latitude: 28.6139,
      longitude: 77.209,
      imageUrls: [],
      isPublic: true,
      useAiAnalysis: true,
      aiConsentToken: consentToken,
    });

    expect(response.status).toBe(201);
    expect(serviceMocks.classifyIncident).toHaveBeenCalledTimes(1);
    expect(serviceMocks.classifyIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title, description }),
      { allowExternalAI: true },
    );
  });

  it('rejects address-like public incident search terms without querying records', async () => {
    const response = await requestIncident('/api/incidents/public?search=17%20Juniper%20Road', 'GET');

    expect(response.status).toBe(400);
    expect(prismaMock.incident.findMany).not.toHaveBeenCalled();
  });

  it('does not match ordinary public searches against stored exact location text', async () => {
    const response = await requestIncident('/api/incidents/public?search=pothole', 'GET');

    expect(response.status).toBe(200);
    const where = prismaMock.incident.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { title: { contains: 'pothole', mode: 'insensitive' } },
      { description: { contains: 'pothole', mode: 'insensitive' } },
    ]);
    expect(where.OR.some((clause: Record<string, unknown>) => 'locationText' in clause)).toBe(false);
  });
});
