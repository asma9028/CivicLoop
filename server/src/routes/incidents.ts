import { Prisma, type VerificationActionType } from '@prisma/client';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js';
import { classifyIncident, ruleBasedClassification } from '../services/ai/classifier.js';
import { recommendDepartment } from '../services/ai/departments.js';
import { findPotentialDuplicates } from '../services/ai/duplicates.js';
import { calculatePriority } from '../services/ai/priority.js';
import { consumeAiConsent, issueAiConsent } from '../services/ai/consent.js';
import type { AnalysisInput } from '../services/ai/types.js';
import { hasActiveAuthorityDepartment } from '../utils/authorization.js';
import { sanitizePublicText, serializePublicIncident } from '../utils/public-incident.js';
import { logSafeError } from '../utils/safe-logger.js';

export const incidentsRouter = Router();
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const categories = ['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER'] as const;
const consentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const publicConfirmationTypes: VerificationActionType[] = ['CITIZEN_CONFIRMED', 'REVIEW_CONFIRMED'];
const publicVerificationInclude = {
  orderBy: { createdAt: 'desc' as const },
  take: 1,
  select: {
    status: true,
    createdAt: true,
    resolutionEvidence: {
      select: {
        evidenceDescription: true,
        workCompleted: true,
        resolutionDate: true,
        evidenceImageUrls: true,
      },
    },
    actions: {
      where: { actionType: { in: publicConfirmationTypes } },
      orderBy: { createdAt: 'desc' as const },
      take: 1,
      select: { actionType: true, createdAt: true },
    },
  },
} satisfies Prisma.VerificationCaseFindManyArgs;
const coordinateSchema = z.number().finite();
const incidentConsentSchema = z.object({
  accepted: z.literal(true),
  operation: z.enum(['INCIDENT_PREVIEW', 'INCIDENT_SUBMISSION']),
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(2_000),
}).strict();
const draftSchema = z.object({
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(2_000),
  category: z.enum(categories).optional(),
  locationText: z.string().trim().max(250).optional(),
  latitude: coordinateSchema.min(-90).max(90).optional(),
  longitude: coordinateSchema.min(-180).max(180).optional(),
  useAiAnalysis: z.boolean().default(false),
  aiConsentToken: z.string().min(1).max(2_048).optional(),
}).strict().refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
  message: 'Latitude and longitude must be provided together',
});

const createSchema = z.object({
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(2_000),
  category: z.enum(categories),
  subcategory: z.string().trim().max(80).optional(),
  locationText: z.string().trim().min(3).max(250),
  latitude: coordinateSchema.min(-90).max(90),
  longitude: coordinateSchema.min(-180).max(180),
  imageUrls: z.array(z.string().regex(/^\/api\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/i)).max(5)
    .refine((urls) => new Set(urls).size === urls.length, 'Duplicate image references are not allowed'),
  isPublic: z.boolean().default(true),
  useAiAnalysis: z.boolean().default(false),
  aiConsentToken: z.string().min(1).max(2_048).optional(),
  confirmedDuplicateId: z.string().cuid().optional(),
}).strict();

function analysisResult(input: AnalysisInput, classification: Awaited<ReturnType<typeof classifyIncident>>, department: Awaited<ReturnType<typeof recommendDepartment>>, duplicates: Awaited<ReturnType<typeof findPotentialDuplicates>>) {
  const priority = calculatePriority({
    severity: classification.severity,
    safetyRisk: classification.safetyRisk,
    publicImpact: classification.publicImpact,
    timeSensitivity: classification.timeSensitivity,
    confidence: Math.round(classification.confidence * 100),
  });
  return {
    classification,
    summary: classification.summary,
    priority,
    department,
    duplicates,
    source: classification.source,
    note: classification.source === 'gemini'
      ? 'AI-generated suggestion; review before submitting.'
      : 'Rule-based fallback suggestion; review before submitting.',
    inputCategory: input.category ?? null,
  };
}

async function analyze(input: AnalysisInput, allowExternalAI = false) {
  const classification = allowExternalAI
    ? await classifyIncident(input, { allowExternalAI: true })
    : ruleBasedClassification(input);
  const department = await recommendDepartment(classification.category, classification.confidence);
  const duplicates = await findPotentialDuplicates({ ...input, category: input.category ?? classification.category });
  return analysisResult(input, classification, department, duplicates);
}

incidentsRouter.post('/analysis-consent', consentLimiter, requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const parsed = incidentConsentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Explicit AI consent and valid report text are required' });
  try {
    const consentToken = await issueAiConsent({
      userId: req.user!.id,
      purpose: 'INCIDENT_CLASSIFICATION',
      operation: parsed.data.operation,
      subject: { title: parsed.data.title, description: parsed.data.description },
    });
    return res.json({ consentToken });
  } catch (error) {
    logSafeError('incidents.analysis-consent', error, res.getHeader('X-Request-Id'));
    return res.status(503).json({ error: 'AI consent could not be recorded. Please try again.' });
  }
});

incidentsRouter.post('/analyze', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the report details', fields: parsed.error.flatten().fieldErrors });
  try {
    if (parsed.data.useAiAnalysis && !(await consumeAiConsent(parsed.data.aiConsentToken, {
      userId: req.user!.id,
      purpose: 'INCIDENT_CLASSIFICATION',
      operation: 'INCIDENT_PREVIEW',
      subject: { title: parsed.data.title, description: parsed.data.description },
    }))) {
      return res.status(403).json({ error: 'Explicit, current AI consent is required for report analysis' });
    }
    res.json({ analysis: await analyze(parsed.data, parsed.data.useAiAnalysis) });
  } catch (error) {
    logSafeError('incidents.analyze', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Incident analysis is temporarily unavailable' });
  }
});

incidentsRouter.post('/duplicates', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the report details', fields: parsed.error.flatten().fieldErrors });
  try {
    const duplicates = await findPotentialDuplicates(parsed.data);
    res.json({ duplicates, radiusMeters: Number(process.env.INCIDENT_DUPLICATE_RADIUS_METERS) || 300 });
  } catch (error) {
    logSafeError('incidents.duplicates', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Duplicate search is temporarily unavailable' });
  }
});

incidentsRouter.post('/', reportLimiter, requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the report details', fields: parsed.error.flatten().fieldErrors });
  try {
    const storedNames = parsed.data.imageUrls.map((url) => url.slice('/api/uploads/'.length));
    const ownedUploads = storedNames.length
      ? await prisma.incidentUpload.findMany({
        where: { storedName: { in: storedNames }, uploadedByUserId: req.user!.id, incidentId: null },
        select: { storedName: true },
      })
      : [];
    if (ownedUploads.length !== storedNames.length) return res.status(400).json({ error: 'One or more evidence images are invalid or were uploaded by another user' });
    if (parsed.data.useAiAnalysis && !(await consumeAiConsent(parsed.data.aiConsentToken, {
      userId: req.user!.id,
      purpose: 'INCIDENT_CLASSIFICATION',
      operation: 'INCIDENT_SUBMISSION',
      subject: { title: parsed.data.title, description: parsed.data.description },
    }))) {
      return res.status(403).json({ error: 'Explicit, current AI consent is required to submit with AI analysis' });
    }
    const input = {
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      locationText: parsed.data.locationText,
    };
    const intelligence = await analyze(input, parsed.data.useAiAnalysis);
    if (parsed.data.confirmedDuplicateId && !intelligence.duplicates.some((match) => match.id === parsed.data.confirmedDuplicateId)) {
      return res.status(400).json({ error: 'The confirmed matching incident is no longer available' });
    }
    const recommendationCategory = intelligence.classification.confidence >= 0.5
      ? intelligence.classification.category
      : parsed.data.category;
    const department = await recommendDepartment(recommendationCategory, intelligence.classification.confidence);
    const duplicateOfIncidentId = parsed.data.confirmedDuplicateId ?? null;

    const incident = await prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          title: parsed.data.title,
          description: parsed.data.description,
          category: parsed.data.category,
          subcategory: parsed.data.subcategory ?? intelligence.classification.subcategory,
          locationText: parsed.data.locationText,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
          imageUrls: parsed.data.imageUrls,
          reporterId: req.user!.id,
          departmentId: department.id,
          severity: intelligence.classification.severity,
          priorityScore: intelligence.priority.score,
          priorityBand: intelligence.priority.band,
          priorityBreakdown: intelligence.priority.breakdown,
          status: parsed.data.confirmedDuplicateId ? 'DUPLICATE' : 'REPORTED',
          isPublic: parsed.data.isPublic,
          duplicateOfIncidentId,
          aiSummary: intelligence.summary,
          aiAnalysisStatus: 'COMPLETED',
          aiCategory: intelligence.classification.category,
          aiSubcategory: intelligence.classification.subcategory,
          aiConfidence: intelligence.classification.confidence,
          aiReasoning: intelligence.classification.reasoning,
          aiProvider: intelligence.source,
        },
        include: { department: { select: { id: true, name: true, code: true } } },
      });
      if (storedNames.length) {
        const attached = await tx.incidentUpload.updateMany({
          where: { storedName: { in: storedNames }, uploadedByUserId: req.user!.id, incidentId: null },
          data: { incidentId: created.id },
        });
        if (attached.count !== storedNames.length) throw new Error('Evidence upload ownership changed during report submission');
      }
      await tx.incidentActivity.create({
        data: {
          incidentId: created.id,
          actorUserId: req.user!.id,
          activityType: 'OTHER',
          activityDescription: parsed.data.confirmedDuplicateId
            ? 'Citizen submitted a report and confirmed a possible matching incident.'
            : 'Citizen submitted a new incident report.',
          metadata: {
            aiSource: intelligence.source,
            priorityScore: intelligence.priority.score,
            priorityBand: intelligence.priority.band,
            potentialDuplicateIds: intelligence.duplicates.map((item) => item.id),
            confirmedDuplicateId: parsed.data.confirmedDuplicateId ?? null,
          },
        },
      });
      return created;
    });

    res.status(201).json({
      incident: {
        id: incident.id,
        title: incident.title,
        category: incident.category,
        status: incident.status,
        priorityScore: incident.priorityScore,
        priorityBand: incident.priorityBand,
        createdAt: incident.createdAt,
        department: incident.department,
        duplicateOfIncidentId: incident.duplicateOfIncidentId,
      },
    });
  } catch (error) {
    logSafeError('incidents.create', error, res.getHeader('X-Request-Id'));
    if (error instanceof Error && error.message === 'Evidence upload ownership changed during report submission') {
      return res.status(409).json({ error: 'Evidence was already attached to another report. Upload it again before submitting.' });
    }
    res.status(503).json({ error: 'Unable to save the report. Please try again.' });
  }
});

incidentsRouter.get('/public', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search && sanitizePublicText(search, 120) !== search) {
    return res.status(400).json({ error: 'Search cannot include an address or sensitive identifier' });
  }
  const category = categories.find((value) => value === req.query.category);
  const statuses = ['REPORTED','ACKNOWLEDGED','IN_PROGRESS','RESOLUTION_SUBMITTED','VERIFICATION_PENDING','RESOLVED','REOPENED','ON_HOLD','REJECTED','DUPLICATE'] as const;
  const status = statuses.find((value) => value === req.query.status);
  const priorities = ['P1','P2','P3','P4'] as const;
  const priorityBandFilter = priorities.find((value) => value === req.query.priority);
  const sort = req.query.sort === 'oldest' ? 'asc' : req.query.sort === 'priority' ? undefined : 'desc';
  const where = {
    isPublic: true,
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
    ...(priorityBandFilter ? { priorityBand: priorityBandFilter } : {}),
    ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { description: { contains: search, mode: 'insensitive' as const } }] } : {}),
  };
  try {
    const [items,total,statusCounts,categoryCounts,departmentCounts] = await prisma.$transaction([
      prisma.incident.findMany({
        where,
        skip: (page-1)*limit,
        take: limit,
        orderBy: req.query.sort === 'priority' ? [{ priorityScore: 'desc' }, { createdAt: 'desc' }] : { createdAt: sort },
        select: {
          id: true, title: true, description: true, category: true, subcategory: true, locationText: true,
          latitude: true, longitude: true, status: true, priorityScore: true, priorityBand: true,
          imageUrls: true, createdAt: true, aiSummary: true,
          department: { select: { id: true, name: true } },
          uploads: { where: { isPublic: true }, select: { storedName: true } },
          verificationCases: publicVerificationInclude,
        },
      }),
      prisma.incident.count({ where }),
      prisma.incident.groupBy({ by: ['status'], where, orderBy: { status: 'asc' }, _count: true }),
      prisma.incident.groupBy({ by: ['category'], where, orderBy: { category: 'asc' }, _count: true }),
      prisma.incident.groupBy({ by: ['departmentId', 'status'], where, orderBy: [{ departmentId: 'asc' }, { status: 'asc' }], _count: true }),
    ]);
    const departmentIds = departmentCounts.map((entry) => entry.departmentId).filter((id): id is string => Boolean(id));
    const departments = await prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } });
    res.json({
      incidents: items.map(publicIncident),
      aggregates: {
        statuses: Object.fromEntries(statusCounts.map((entry) => [entry.status, entry._count])),
        categories: Object.fromEntries(categoryCounts.map((entry) => [entry.category, entry._count])),
        departments: departments.map((department) => ({
          id: department.id,
          name: department.name,
          total: departmentCounts.filter((entry) => entry.departmentId === department.id).reduce((sum, entry) => {
            const count = entry._count;
            return sum + (typeof count === 'object' && count !== null ? count._all ?? 0 : 0);
          }, 0),
          resolved: departmentCounts.find((entry) => entry.departmentId === department.id && entry.status === 'RESOLVED')?._count ?? 0,
        })),
      },
      pagination: { page, limit, total, pages: Math.ceil(total/limit) },
    });
  } catch (error) {
    logSafeError('incidents.public-list', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Public incidents are temporarily unavailable' });
  }
});

incidentsRouter.get('/my', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const statuses = ['REPORTED','ACKNOWLEDGED','IN_PROGRESS','RESOLUTION_SUBMITTED','VERIFICATION_PENDING','RESOLVED','REOPENED','ON_HOLD','REJECTED','DUPLICATE'] as const;
  const status = statuses.find((value) => value === req.query.status);
  const where = { reporterId: req.user!.id, ...(status ? { status } : {}) };
  try {
    const [items,total,statusCounts] = await prisma.$transaction([
      prisma.incident.findMany({
        where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: 'desc' },
        include: { department: { select: { id: true, name: true } }, duplicateOf: { select: { id: true, title: true, status: true } } },
      }),
      prisma.incident.count({ where }),
      prisma.incident.groupBy({ by: ['status'], where: { reporterId: req.user!.id }, orderBy: { status: 'asc' }, _count: true }),
    ]);
    const counts = Object.fromEntries(statusCounts.map((entry) => [entry.status, entry._count]));
    res.json({ incidents: items.map(citizenIncident), counts, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (error) {
    logSafeError('incidents.my-list', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Your reports are temporarily unavailable' });
  }
});

incidentsRouter.get('/:id', optionalAuth, async (req, res) => {
  const incidentId = req.params.id;
  if (typeof incidentId !== 'string') return res.status(404).json({ error: 'Incident not found' });
  try {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
      include: {
        department: { select: { id: true, name: true, code: true } },
        duplicateOf: { select: { id: true, title: true, status: true } },
        activities: {
          where: { visibility: 'PUBLIC' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, activityType: true, activityDescription: true, previousStatus: true, newStatus: true, createdAt: true, actor: { select: { fullName: true } } },
        },
        uploads: { where: { isPublic: true }, select: { storedName: true } },
        verificationCases: publicVerificationInclude,
      },
    });
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (incident.isPublic) return res.json({
      incident: {
        ...publicIncident(incident),
        activities: incident.activities.map((activity) => ({
          ...activity,
          activityDescription: sanitizePublicText(activity.activityDescription),
          actor: null,
        })),
      },
    });
    if (!req.user) return res.status(404).json({ error: 'Incident not found' });
    if (req.user.role === 'CITIZEN' && incident.reporterId !== req.user.id) return res.status(404).json({ error: 'Incident not found' });
    if (req.user.role === 'AUTHORITY') {
      const profile = await prisma.authorityProfile.findUnique({
        where: { userId: req.user.id },
        include: { department: { select: { status: true } } },
      });
      if (!hasActiveAuthorityDepartment(profile, incident.departmentId)) return res.status(404).json({ error: 'Incident not found' });
    }
    res.json({ incident: { ...citizenIncident(incident), activities: incident.activities } });
  } catch (error) {
    logSafeError('incidents.detail', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Incident details are temporarily unavailable' });
  }
});

function publicIncident(incident: {
  id: string; title: string; description: string; category: string; subcategory?: string | null;
  locationText: string; latitude: number; longitude: number; status: string; priorityScore: number;
  priorityBand: string; imageUrls: string[]; createdAt: Date; aiSummary?: string | null;
  department?: { id: string; name: string } | null;
  uploads?: Array<{ storedName: string }>;
  verificationCases?: Array<{
    status: string;
    createdAt: Date;
    resolutionEvidence: { evidenceDescription: string; workCompleted: string | null; resolutionDate: Date | null; evidenceImageUrls: string[] };
    actions: Array<{ actionType: string; createdAt: Date }>;
  }>;
}) {
  const latestCase = incident.verificationCases?.[0];
  const verifiedCase = incident.status === 'RESOLVED' && latestCase?.status === 'VERIFIED' ? latestCase : undefined;
  const verificationStatus = latestCase?.status === 'DISPUTED' || latestCase?.status === 'REVIEW_REQUIRED'
    ? 'UNDER_REVIEW'
    : latestCase?.status === 'PENDING'
      ? 'PENDING'
      : undefined;
  const publicUploads = new Set(incident.uploads?.map((upload) => upload.storedName) ?? []);
  const verifiedAction = verifiedCase?.actions[0];
  return {
    id: incident.id,
    ...serializePublicIncident(incident),
    status: incident.status,
    priorityScore: incident.priorityScore,
    priorityBand: incident.priorityBand,
    imageUrls: incident.imageUrls.filter((url) => publicUploads.has(url.slice('/api/uploads/'.length))),
    createdAt: incident.createdAt,
    department: incident.department,
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(verifiedCase ? {
      verification: {
        status: 'VERIFIED',
        verifiedAt: verifiedAction?.createdAt ?? verifiedCase.createdAt,
        method: verifiedAction?.actionType === 'REVIEW_CONFIRMED' ? 'Independent review' : 'Citizen confirmation',
        resolutionSummary: sanitizePublicText(verifiedCase.resolutionEvidence.evidenceDescription),
        workCompleted: verifiedCase.resolutionEvidence.workCompleted
          ? sanitizePublicText(verifiedCase.resolutionEvidence.workCompleted)
          : null,
        resolutionDate: verifiedCase.resolutionEvidence.resolutionDate,
        evidenceImageUrls: verifiedCase.resolutionEvidence.evidenceImageUrls.filter((url) =>
          publicUploads.has(url.slice('/api/uploads/'.length)),
        ),
      },
    } : {}),
  };
}

function citizenIncident(incident: {
  id: string; title: string; description: string; category: string; subcategory?: string | null;
  locationText: string; latitude: number; longitude: number; status: string; priorityScore: number;
  priorityBand: string; severity: string; imageUrls: string[]; createdAt: Date; aiSummary?: string | null;
  aiCategory?: string | null; aiSubcategory?: string | null; aiConfidence?: number | null;
  aiReasoning?: string | null; aiProvider?: string | null; duplicateOfIncidentId?: string | null;
  isPublic: boolean; department?: { id: string; name: string; code?: string } | null;
  duplicateOf?: { id: string; title: string; status: string } | null;
  uploads?: Array<{ storedName: string }>;
  verificationCases?: Array<{
    status: string;
    createdAt: Date;
    resolutionEvidence: { evidenceDescription: string; workCompleted: string | null; resolutionDate: Date | null; evidenceImageUrls: string[] };
    actions: Array<{ actionType: string; createdAt: Date }>;
  }>;
}) {
  return {
    ...publicIncident(incident),
    title: incident.title,
    description: incident.description,
    summary: incident.aiSummary,
    subcategory: incident.subcategory,
    locationText: incident.locationText,
    latitude: incident.latitude,
    longitude: incident.longitude,
    imageUrls: incident.imageUrls,
    severity: incident.severity,
    aiAnalysis: {
      category: incident.aiCategory,
      subcategory: incident.aiSubcategory,
      confidence: incident.aiConfidence,
      reasoning: incident.aiReasoning,
      source: incident.aiProvider,
    },
    isPublic: incident.isPublic,
    duplicateOf: incident.duplicateOf,
  };
}
