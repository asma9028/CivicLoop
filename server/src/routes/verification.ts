import { Prisma, type VerificationCaseStatus } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import {
  verificationDisputeEscalationHours,
  verificationResponseHours,
  verificationReviewOverdueHours,
} from '../config/verification.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { consumeAiConsent, issueAiConsent } from '../services/ai/consent.js';
import { InvalidIncidentTransitionError, transitionIncident } from '../services/incidents/lifecycle.js';
import { analyzeResolutionEvidence } from '../services/verification/analysis.js';
import { citizenResponseOutcome, independentReviewOutcome } from '../services/verification/workflow.js';
import { logSafeError } from '../utils/safe-logger.js';

export const verificationRouter = Router();

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const dateQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'The start date must be on or before the end date',
});
const uploadUrl = z.string().regex(/^\/api\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/i);
const responseSchema = z.object({
  decision: z.enum(['CONFIRM', 'ISSUE_REMAINS', 'INCOMPLETE', 'EVIDENCE_MISMATCH', 'REQUEST_FURTHER_ACTION']),
  reason: z.string().trim().max(2_000).optional(),
  evidenceUrls: z.array(uploadUrl).max(5).default([]),
}).strict().superRefine((value, context) => {
  if (value.decision !== 'CONFIRM' && (!value.reason || value.reason.length < 10)) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Please explain the concern in at least 10 characters' });
  }
  if (new Set(value.evidenceUrls).size !== value.evidenceUrls.length) {
    context.addIssue({ code: 'custom', path: ['evidenceUrls'], message: 'Duplicate evidence references are not allowed' });
  }
});
const additionalEvidenceSchema = z.object({
  description: z.string().trim().min(3).max(2_000),
  evidenceUrls: z.array(uploadUrl).min(1).max(5),
}).strict().refine((value) => new Set(value.evidenceUrls).size === value.evidenceUrls.length, {
  message: 'Duplicate evidence references are not allowed',
});
const reviewerSchema = z.object({ reviewerId: z.string().min(1).max(64).nullable() }).strict();
const reviewSchema = z.object({
  decision: z.enum(['CONFIRM', 'REOPEN', 'REQUEST_EVIDENCE']),
  reason: z.string().trim().min(10).max(2_000),
}).strict();
const aiConsentSchema = z.object({ accepted: z.literal(true) }).strict();

const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const analysisLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const consentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const publicMetricsLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

const verificationCaseInclude = {
  incident: {
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      severity: true,
      priorityBand: true,
      locationText: true,
      latitude: true,
      longitude: true,
      imageUrls: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      reporterId: true,
      departmentId: true,
      department: { select: { id: true, name: true, code: true } },
      assignedAuthority: { select: { id: true, fullName: true } },
      activities: {
        where: { visibility: 'PUBLIC' as const },
        orderBy: { createdAt: 'asc' as const },
        select: { activityType: true, activityDescription: true, createdAt: true },
      },
      uploads: { select: { storedName: true, createdAt: true } },
    },
  },
  resolutionEvidence: {
    select: {
      id: true,
      submittedByUserId: true,
      evidenceImageUrls: true,
      evidenceDescription: true,
      workCompleted: true,
      resolutionDate: true,
      submittedAt: true,
      verificationResult: true,
      verifiedAt: true,
    },
  },
  assignedReviewer: { select: { id: true, fullName: true } },
  actions: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { id: true, fullName: true, role: true } } },
  },
  analyses: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.VerificationCaseInclude;

type VerificationCaseRecord = Prisma.VerificationCaseGetPayload<{ include: typeof verificationCaseInclude }>;

function getId(req: Request) {
  return typeof req.params.id === 'string' ? req.params.id : null;
}

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function responseError(res: Response, error: unknown, message: string, status = 503) {
  if (error instanceof InvalidIncidentTransitionError) return res.status(409).json({ error: error.message });
  if (error instanceof Error && error.message.startsWith('Review case changed')) return res.status(409).json({ error: error.message });
  logSafeError('verification.request', error, res.getHeader('X-Request-Id'));
  return res.status(status).json({ error: message });
}

function serializeCase(record: VerificationCaseRecord) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    citizenDecision: record.citizenDecision,
    citizenRespondedAt: record.citizenRespondedAt,
    responseDeadline: record.responseDeadline,
    remainingResponseHours: Math.max(0, Math.ceil((record.responseDeadline.getTime() - Date.now()) / 3_600_000)),
    ageHours: Math.max(0, Math.floor((Date.now() - record.createdAt.getTime()) / 3_600_000)),
    escalationAt: record.escalationAt,
    reviewDueAt: record.reviewDueAt,
    overdue: record.status === 'PENDING'
      ? record.responseDeadline.getTime() <= Date.now()
      : record.status === 'REVIEW_REQUIRED'
        ? Boolean(record.reviewDueAt && record.reviewDueAt.getTime() <= Date.now())
        : record.status === 'DISPUTED' && Boolean(record.escalationAt && record.escalationAt.getTime() <= Date.now()),
    assignedReviewer: record.assignedReviewer,
    incident: {
      id: record.incident.id,
      title: record.incident.title,
      description: record.incident.description,
      category: record.incident.category,
      severity: record.incident.severity,
      priorityBand: record.incident.priorityBand,
      locationText: record.incident.locationText,
      imageUrls: record.incident.imageUrls,
      imageEvidence: record.incident.imageUrls.map((url) => {
        const storedName = url.slice('/api/uploads/'.length);
        const upload = record.incident.uploads.find((item) => item.storedName === storedName);
        return { url, uploadedAt: upload?.createdAt ?? null };
      }),
      status: record.incident.status,
      createdAt: record.incident.createdAt,
      department: record.incident.department,
      assignedAuthority: record.incident.assignedAuthority,
      activities: record.incident.activities,
    },
    resolution: {
      id: record.resolutionEvidence.id,
      evidenceImageUrls: record.resolutionEvidence.evidenceImageUrls,
      evidenceDescription: record.resolutionEvidence.evidenceDescription,
      workCompleted: record.resolutionEvidence.workCompleted,
      resolutionDate: record.resolutionEvidence.resolutionDate,
      submittedAt: record.resolutionEvidence.submittedAt,
      verificationResult: record.resolutionEvidence.verificationResult,
      verifiedAt: record.resolutionEvidence.verifiedAt,
      evidenceImages: record.resolutionEvidence.evidenceImageUrls.map((url) => {
        const storedName = url.slice('/api/uploads/'.length);
        const upload = record.incident.uploads.find((item) => item.storedName === storedName);
        return { url, uploadedAt: upload?.createdAt ?? null };
      }),
    },
    actions: record.actions.map((action) => ({
      id: action.id,
      actionType: action.actionType,
      reason: action.reason,
      evidenceUrls: action.evidenceUrls,
      createdAt: action.createdAt,
      actor: action.actor ? { id: action.actor.id, fullName: action.actor.fullName, role: action.actor.role } : null,
    })),
    analyses: record.analyses.map((analysis) => ({
      id: analysis.id,
      recommendation: analysis.result,
      confidence: analysis.confidence,
      evidenceRelevance: analysis.evidenceRelevance,
      apparentImprovement: analysis.apparentImprovement,
      evidenceQuality: analysis.evidenceQuality,
      potentialInconsistencies: analysis.potentialInconsistencies,
      explanation: analysis.explanation,
      recommendedNextAction: analysis.recommendedNextAction,
      provider: analysis.provider,
      model: analysis.model,
      createdAt: analysis.createdAt,
    })),
  };
}

async function findCase(id: string) {
  return prisma.verificationCase.findUnique({ where: { id }, include: verificationCaseInclude });
}

function verificationAnalysisInput(record: VerificationCaseRecord) {
  return {
    title: record.incident.title,
    category: record.incident.category,
    description: record.incident.description,
    locationText: record.incident.locationText,
    originalImageUrls: record.incident.imageUrls,
    resolutionDescription: record.resolutionEvidence.evidenceDescription,
    workCompleted: record.resolutionEvidence.workCompleted,
    resolutionDate: record.resolutionEvidence.resolutionDate,
    resolutionImageUrls: record.resolutionEvidence.evidenceImageUrls,
    history: record.incident.activities,
  };
}

async function canAccessCase(record: VerificationCaseRecord, userId: string, role: string) {
  if (role === 'ADMIN' || record.incident.reporterId === userId) return true;
  if (role !== 'AUTHORITY') return false;
  const profile = await prisma.authorityProfile.findUnique({
    where: { userId },
    select: { departmentId: true, department: { select: { status: true } } },
  });
  return Boolean(profile && profile.department.status === 'ACTIVE' && profile.departmentId === record.incident.departmentId);
}

async function attachPrivateEvidence(
  tx: Prisma.TransactionClient,
  urls: string[],
  incidentId: string,
  userId: string,
) {
  if (!urls.length) return;
  const names = urls.map((url) => url.slice('/api/uploads/'.length));
  const uploaded = await tx.incidentUpload.findMany({
    where: { storedName: { in: names }, uploadedByUserId: userId, incidentId: null },
    select: { storedName: true },
  });
  if (uploaded.length !== names.length) throw new Error('One or more evidence images are invalid or not owned by the uploading citizen');
  const attached = await tx.incidentUpload.updateMany({
    where: { storedName: { in: names }, uploadedByUserId: userId, incidentId: null },
    data: { incidentId, isPublic: false },
  });
  if (attached.count !== names.length) throw new Error('Evidence upload ownership changed during verification');
}

async function escalateOverdueCases(scope?: { reporterId?: string; departmentId?: string }) {
  const now = new Date();
  const overdue = await prisma.verificationCase.findMany({
    where: {
      ...(scope?.reporterId ? { incident: { reporterId: scope.reporterId } } : {}),
      ...(scope?.departmentId ? { incident: { departmentId: scope.departmentId } } : {}),
      OR: [
        { status: 'PENDING', responseDeadline: { lte: now } },
        { status: 'DISPUTED', escalationAt: { lte: now } },
      ],
    },
    select: { id: true, incidentId: true, status: true },
    take: 200,
    orderBy: { responseDeadline: 'asc' },
  });
  let escalated = 0;
  for (const candidate of overdue) {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.verificationCase.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          ...(candidate.status === 'PENDING'
            ? { responseDeadline: { lte: now } }
            : { escalationAt: { lte: now } }),
        },
        data: {
          status: 'REVIEW_REQUIRED',
          escalationAt: now,
          reviewDueAt: hoursFromNow(verificationReviewOverdueHours),
        },
      });
      if (!changed.count) return;
      escalated += 1;
      await tx.verificationAction.create({
        data: {
          caseId: candidate.id,
          actionType: 'DEADLINE_ESCALATED',
          reason: candidate.status === 'PENDING'
            ? 'The citizen response deadline passed without an automatic approval.'
            : 'The dispute escalation deadline passed and requires independent review.',
          metadata: { previousStatus: candidate.status },
        },
      });
      await tx.incidentActivity.create({
        data: {
          incidentId: candidate.incidentId,
          activityType: 'INTERNAL_NOTE',
          activityDescription: 'Verification deadline reached; independent review is available.',
          visibility: 'INTERNAL',
        },
      });
    });
  }
  return escalated;
}

verificationRouter.get('/public/departments/:departmentId/metrics', publicMetricsLimiter, async (req, res) => {
  const departmentId = typeof req.params.departmentId === 'string' ? req.params.departmentId : null;
  if (!departmentId) return res.status(400).json({ error: 'A department is required' });
  const parsed = dateQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid metrics date range' });
  try {
    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true } });
    if (!department) return res.status(404).json({ error: 'Department not found' });
    const createdAt: Prisma.DateTimeFilter = {};
    if (parsed.data.from) createdAt.gte = new Date(`${parsed.data.from}T00:00:00.000Z`);
    if (parsed.data.to) {
      const until = new Date(`${parsed.data.to}T00:00:00.000Z`);
      until.setUTCDate(until.getUTCDate() + 1);
      createdAt.lt = until;
    }
    return res.json(await calculateMetrics(department, Object.keys(createdAt).length ? createdAt : undefined));
  } catch (error) {
    return responseError(res, error, 'Department verification metrics are temporarily unavailable');
  }
});

verificationRouter.use(requireAuth);

verificationRouter.post('/process-deadlines', requireRole('CITIZEN', 'AUTHORITY', 'ADMIN'), async (req, res) => {
  try {
    let scope: { reporterId?: string; departmentId?: string } | undefined;
    if (req.user!.role === 'CITIZEN') {
      scope = { reporterId: req.user!.id };
    } else if (req.user!.role === 'AUTHORITY') {
      const profile = await prisma.authorityProfile.findUnique({
        where: { userId: req.user!.id },
        include: { department: { select: { status: true } } },
      });
      if (!profile || profile.department.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'An active authority department assignment is required' });
      }
      scope = { departmentId: profile.departmentId };
    }
    const escalated = await escalateOverdueCases(scope);
    return res.json({ escalated });
  } catch (error) {
    return responseError(res, error, 'Unable to process verification deadlines');
  }
});

verificationRouter.get('/me', requireRole('CITIZEN'), async (req, res) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification page' });
  try {
    const where = { reporterId: req.user!.id };
    const [cases, total] = await prisma.$transaction([
      prisma.verificationCase.findMany({
        where,
        include: verificationCaseInclude,
        orderBy: [{ status: 'asc' }, { responseDeadline: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.verificationCase.count({ where }),
    ]);
    return res.json({
      cases: cases.map(serializeCase),
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return responseError(res, error, 'Verification requests are temporarily unavailable');
  }
});

verificationRouter.get('/cases/:id', async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record || !(await canAccessCase(record, req.user!.id, req.user!.role))) {
      return res.status(404).json({ error: 'Verification case not found' });
    }
    const updated = await findCase(id);
    return res.json({ verification: updated ? serializeCase(updated) : null });
  } catch (error) {
    return responseError(res, error, 'Verification details are temporarily unavailable');
  }
});

verificationRouter.post('/cases/:id/respond', writeLimiter, requireRole('CITIZEN'), async (req, res) => {
  const parsed = responseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification response', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record || record.incident.reporterId !== req.user!.id) return res.status(404).json({ error: 'Verification case not found' });
    if (record.incident.status !== 'VERIFICATION_PENDING') return res.status(409).json({ error: 'This incident is not awaiting resolution verification' });
    if (!['PENDING', 'REVIEW_REQUIRED'].includes(record.status)) return res.status(409).json({ error: 'This resolution is no longer awaiting a citizen response' });
    if (record.citizenRespondedAt) return res.status(409).json({ error: 'A verification response has already been recorded for this resolution' });
    const outcome = citizenResponseOutcome(parsed.data.decision);
    const disagreement = outcome.caseStatus === 'DISPUTED';
    const result = await prisma.$transaction(async (tx) => {
      await attachPrivateEvidence(tx, parsed.data.evidenceUrls, record.incident.id, req.user!.id);
      const responseTime = new Date();
      const changed = await tx.verificationCase.updateMany({
        where: {
          id,
          citizenRespondedAt: null,
          status: { in: ['PENDING', 'REVIEW_REQUIRED'] },
        },
        data: {
          status: outcome.caseStatus,
          citizenDecision: parsed.data.decision,
          citizenRespondedAt: responseTime,
          ...(disagreement
            ? {
              escalationAt: hoursFromNow(verificationDisputeEscalationHours),
              reviewDueAt: hoursFromNow(verificationReviewOverdueHours),
            }
            : {}),
        },
      });
      if (!changed.count) throw new Error('This verification response was already recorded');
      await tx.verificationAction.create({
        data: {
          caseId: id,
          actorUserId: req.user!.id,
          actionType: outcome.actionType,
          reason: parsed.data.reason || null,
          evidenceUrls: parsed.data.evidenceUrls,
          metadata: { decision: parsed.data.decision },
        },
      });
      if (disagreement) {
        await tx.incidentActivity.create({
          data: {
            incidentId: record.incident.id,
            activityType: 'VERIFICATION_DISPUTED',
            activityDescription: 'The resolution was disputed and referred for independent review.',
            visibility: 'PUBLIC',
          },
        });
      } else if (outcome.incidentTarget) {
        await transitionIncident(tx, {
          incidentId: record.incident.id,
          actorUserId: req.user!.id,
          target: outcome.incidentTarget,
          activityType: 'VERIFICATION_CONFIRMED',
          activityDescription: 'The reporting citizen confirmed the submitted resolution.',
        });
        await tx.resolutionEvidence.update({
          where: { id: record.resolutionEvidenceId },
          data: { verificationResult: 'LIKELY_RESOLVED', verifiedAt: responseTime },
        });
      }
      return tx.verificationCase.findUnique({ where: { id }, include: verificationCaseInclude });
    });
    return res.status(201).json({ verification: result ? serializeCase(result) : null });
  } catch (error) {
    if (error instanceof Error && error.message === 'This verification response was already recorded') {
      return res.status(409).json({ error: error.message });
    }
    if (error instanceof Error && error.message.startsWith('One or more evidence images')) return res.status(400).json({ error: error.message });
    if (error instanceof Error && error.message.startsWith('Evidence upload ownership changed')) return res.status(409).json({ error: error.message });
    return responseError(res, error, 'Unable to record the verification response');
  }
});

verificationRouter.post('/cases/:id/evidence', writeLimiter, requireRole('CITIZEN'), async (req, res) => {
  const parsed = additionalEvidenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid additional evidence', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record || record.incident.reporterId !== req.user!.id) return res.status(404).json({ error: 'Verification case not found' });
    if (record.incident.status !== 'VERIFICATION_PENDING') return res.status(409).json({ error: 'This incident is not awaiting resolution verification' });
    if (!['DISPUTED', 'REVIEW_REQUIRED'].includes(record.status)) return res.status(409).json({ error: 'Additional dispute evidence is not available in this verification state' });
    const result = await prisma.$transaction(async (tx) => {
      await attachPrivateEvidence(tx, parsed.data.evidenceUrls, record.incident.id, req.user!.id);
      await tx.verificationAction.create({
        data: {
          caseId: id,
          actorUserId: req.user!.id,
          actionType: 'CITIZEN_EVIDENCE_SUBMITTED',
          reason: parsed.data.description,
          evidenceUrls: parsed.data.evidenceUrls,
        },
      });
      await tx.incidentActivity.create({
        data: {
          incidentId: record.incident.id,
          actorUserId: req.user!.id,
          activityType: 'VERIFICATION_DISPUTED',
          activityDescription: 'Additional information was submitted for verification review.',
          visibility: 'INTERNAL',
        },
      });
      return tx.verificationCase.findUnique({ where: { id }, include: verificationCaseInclude });
    });
    return res.status(201).json({ verification: result ? serializeCase(result) : null });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('One or more evidence images')) return res.status(400).json({ error: error.message });
    if (error instanceof Error && error.message.startsWith('Evidence upload ownership changed')) return res.status(409).json({ error: error.message });
    return responseError(res, error, 'Unable to save additional evidence');
  }
});

verificationRouter.post('/cases/:id/analysis-consent', consentLimiter, async (req, res) => {
  const parsed = aiConsentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Explicit consent is required before requesting AI analysis' });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record || !(await canAccessCase(record, req.user!.id, req.user!.role))) {
      return res.status(404).json({ error: 'Verification case not found' });
    }
    if (!['PENDING', 'DISPUTED', 'REVIEW_REQUIRED'].includes(record.status)) {
      return res.status(409).json({ error: 'AI analysis is only available while verification is under review' });
    }
    const consentToken = await issueAiConsent({
      userId: req.user!.id,
      purpose: 'VERIFICATION_ANALYSIS',
      operation: 'VERIFICATION_ANALYSIS',
      subject: verificationAnalysisInput(record),
    });
    return res.json({ consentToken });
  } catch (error) {
    return responseError(res, error, 'AI consent could not be recorded. Please try again.');
  }
});

verificationRouter.post('/cases/:id/analyze', analysisLimiter, async (req, res) => {
  const parsed = z.object({ aiConsentToken: z.string().min(1).max(2_048) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(403).json({ error: 'Explicit, current AI consent is required for verification analysis' });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record || !(await canAccessCase(record, req.user!.id, req.user!.role))) {
      return res.status(404).json({ error: 'Verification case not found' });
    }
    if (!['PENDING', 'DISPUTED', 'REVIEW_REQUIRED'].includes(record.status)) {
      return res.status(409).json({ error: 'AI analysis is only available while verification is under review' });
    }
    const input = verificationAnalysisInput(record);
    if (!(await consumeAiConsent(parsed.data.aiConsentToken, {
      userId: req.user!.id,
      purpose: 'VERIFICATION_ANALYSIS',
      operation: 'VERIFICATION_ANALYSIS',
      subject: input,
    }))) {
      return res.status(403).json({ error: 'Explicit, current AI consent is required for verification analysis' });
    }
    const analysis = await analyzeResolutionEvidence(input);
    const saved = await prisma.$transaction(async (tx) => {
      const created = await tx.verificationAnalysis.create({
        data: {
          caseId: id,
          result: analysis.result.recommendation,
          confidence: analysis.result.confidence,
          evidenceRelevance: analysis.result.evidenceRelevance,
          apparentImprovement: analysis.result.apparentImprovement,
          evidenceQuality: analysis.result.evidenceQuality,
          potentialInconsistencies: analysis.result.potentialInconsistencies,
          explanation: analysis.result.explanation,
          recommendedNextAction: analysis.result.recommendedNextAction,
          provider: analysis.provider,
          model: analysis.model,
          contextHash: analysis.contextHash,
        },
      });
      await tx.verificationAction.create({
        data: {
          caseId: id,
          actorUserId: req.user!.id,
          actionType: 'AI_ANALYZED',
          reason: analysis.result.explanation,
          metadata: { recommendation: analysis.result.recommendation, provider: analysis.provider },
        },
      });
      return created;
    });
    return res.status(201).json({
      analysis: {
        id: saved.id,
        recommendation: saved.result,
        confidence: saved.confidence,
        evidenceRelevance: saved.evidenceRelevance,
        apparentImprovement: saved.apparentImprovement,
        evidenceQuality: saved.evidenceQuality,
        potentialInconsistencies: saved.potentialInconsistencies,
        explanation: saved.explanation,
        recommendedNextAction: saved.recommendedNextAction,
        provider: saved.provider,
        model: saved.model,
        createdAt: saved.createdAt,
      },
    });
  } catch (error) {
    return responseError(res, error, 'Unable to analyze resolution evidence');
  }
});

verificationRouter.get('/review-queue', requireRole('ADMIN'), async (req, res) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid review queue page' });
  try {
    const where = { status: { in: ['DISPUTED', 'REVIEW_REQUIRED'] as VerificationCaseStatus[] } };
    const [cases, total] = await prisma.$transaction([
      prisma.verificationCase.findMany({
        where,
        include: verificationCaseInclude,
        orderBy: [{ reviewDueAt: 'asc' }, { createdAt: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.verificationCase.count({ where }),
    ]);
    return res.json({
      cases: cases.map(serializeCase),
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return responseError(res, error, 'The verification review queue is temporarily unavailable');
  }
});

verificationRouter.patch('/cases/:id/reviewer', writeLimiter, requireRole('ADMIN'), async (req, res) => {
  const parsed = reviewerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid reviewer assignment', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record) return res.status(404).json({ error: 'Verification case not found' });
    if (!['DISPUTED', 'REVIEW_REQUIRED'].includes(record.status)) return res.status(409).json({ error: 'Only cases requiring independent review can be assigned' });
    if (parsed.data.reviewerId) {
      const reviewer = await prisma.user.findFirst({
        where: { id: parsed.data.reviewerId, role: 'ADMIN', accountStatus: 'ACTIVE' },
        select: { id: true },
      });
      if (!reviewer) return res.status(400).json({ error: 'Select an active independent administrator' });
      if (reviewer.id === record.incident.reporterId || reviewer.id === record.resolutionEvidence.submittedByUserId) {
        return res.status(409).json({ error: 'The reporter or resolution submitter cannot review this case' });
      }
    }
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.verificationCase.updateMany({
        where: {
          id,
          status: record.status,
          assignedReviewerId: record.assignedReviewer?.id ?? null,
          citizenRespondedAt: record.citizenRespondedAt,
          citizenDecision: record.citizenDecision,
        },
        data: { assignedReviewerId: parsed.data.reviewerId },
      });
      if (!changed.count) throw new Error('Review case changed while the assignment was being saved');
      await tx.verificationAction.create({
        data: {
          caseId: id,
          actorUserId: req.user!.id,
          actionType: 'REVIEW_ASSIGNED',
          metadata: { reviewerId: parsed.data.reviewerId },
        },
      });
      return tx.verificationCase.findUnique({ where: { id }, include: verificationCaseInclude });
    });
    return res.json({ verification: updated ? serializeCase(updated) : null });
  } catch (error) {
    return responseError(res, error, 'Unable to assign the independent reviewer');
  }
});

verificationRouter.post('/cases/:id/decision', writeLimiter, requireRole('ADMIN'), async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Verification case not found' });
  try {
    const record = await findCase(id);
    if (!record) return res.status(404).json({ error: 'Verification case not found' });
    if (!['DISPUTED', 'REVIEW_REQUIRED'].includes(record.status)) return res.status(409).json({ error: 'This case is not awaiting independent review' });
    if (record.assignedReviewer && record.assignedReviewer.id !== req.user!.id) {
      return res.status(403).json({ error: 'This case is assigned to another reviewer' });
    }
    if (record.incident.reporterId === req.user!.id || record.resolutionEvidence.submittedByUserId === req.user!.id) {
      return res.status(409).json({ error: 'A person involved in the incident cannot independently review it' });
    }
    const outcome = independentReviewOutcome(parsed.data.decision);
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.verificationCase.updateMany({
        where: {
          id,
          status: record.status,
          citizenRespondedAt: record.citizenRespondedAt,
          citizenDecision: record.citizenDecision,
          assignedReviewerId: record.assignedReviewer?.id ?? null,
        },
        data: {
          status: outcome.caseStatus,
          ...(outcome.incidentTarget ? {} : { reviewDueAt: hoursFromNow(verificationReviewOverdueHours) }),
        },
      });
      if (!changed.count) throw new Error('Review case changed while the decision was being saved');
      if (!outcome.incidentTarget) {
        await tx.verificationAction.create({
          data: { caseId: id, actorUserId: req.user!.id, actionType: outcome.actionType, reason: parsed.data.reason },
        });
      } else {
        await tx.verificationAction.create({
          data: {
            caseId: id,
            actorUserId: req.user!.id,
            actionType: outcome.actionType,
            reason: parsed.data.reason,
          },
        });
        await transitionIncident(tx, {
          incidentId: record.incident.id,
          actorUserId: req.user!.id,
          target: outcome.incidentTarget,
          activityType: outcome.incidentTarget === 'RESOLVED' ? 'VERIFICATION_CONFIRMED' : 'VERIFICATION_REVIEWED',
          activityDescription: outcome.incidentTarget === 'RESOLVED'
            ? 'An independent reviewer confirmed the submitted resolution.'
            : 'An independent reviewer reopened the incident for additional work.',
          reason: parsed.data.reason,
        });
        await tx.resolutionEvidence.update({
          where: { id: record.resolutionEvidenceId },
          data: outcome.incidentTarget === 'RESOLVED'
            ? { verificationResult: 'LIKELY_RESOLVED', verifiedAt: new Date() }
            : { verificationResult: 'LIKELY_UNRESOLVED', verifiedAt: null },
        });
      }
      return tx.verificationCase.findUnique({ where: { id }, include: verificationCaseInclude });
    });
    return res.json({ verification: result ? serializeCase(result) : null });
  } catch (error) {
    return responseError(res, error, 'Unable to save the independent review decision');
  }
});

verificationRouter.get('/analytics', requireRole('AUTHORITY', 'ADMIN'), async (req, res) => {
  const parsed = dateQuerySchema.extend({ departmentId: z.string().min(1).max(64).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification metrics filters' });
  try {
    let department;
    if (req.user!.role === 'AUTHORITY') {
      const profile = await prisma.authorityProfile.findUnique({
        where: { userId: req.user!.id },
        include: { department: { select: { id: true, name: true, status: true } } },
      });
      if (!profile || profile.department.status !== 'ACTIVE') return res.status(403).json({ error: 'An active authority department assignment is required' });
      if (parsed.data.departmentId && parsed.data.departmentId !== profile.departmentId) return res.status(403).json({ error: 'You do not have access to that department' });
      department = profile.department;
    } else {
      if (!parsed.data.departmentId) return res.status(400).json({ error: 'Administrators must select a department' });
      department = await prisma.department.findUnique({ where: { id: parsed.data.departmentId }, select: { id: true, name: true } });
      if (!department) return res.status(404).json({ error: 'Department not found' });
    }
    const createdAt: Prisma.DateTimeFilter = {};
    if (parsed.data.from) createdAt.gte = new Date(`${parsed.data.from}T00:00:00.000Z`);
    if (parsed.data.to) {
      const until = new Date(`${parsed.data.to}T00:00:00.000Z`);
      until.setUTCDate(until.getUTCDate() + 1);
      createdAt.lt = until;
    }
    return res.json(await calculateMetrics(department, Object.keys(createdAt).length ? createdAt : undefined));
  } catch (error) {
    return responseError(res, error, 'Verification metrics are temporarily unavailable');
  }
});

async function calculateMetrics(
  department: { id: string; name: string },
  createdAt?: Prisma.DateTimeFilter,
) {
  const where: Prisma.VerificationCaseWhereInput = {
    incident: { departmentId: department.id, isPublic: true },
    ...(createdAt ? { createdAt } : {}),
  };
  const cases = await prisma.verificationCase.findMany({
    where,
    select: {
      id: true,
      status: true,
      responseDeadline: true,
      escalationAt: true,
      reviewDueAt: true,
      createdAt: true,
      citizenDecision: true,
      incident: { select: { createdAt: true, resolvedAt: true } },
      resolutionEvidence: { select: { evidenceDescription: true, workCompleted: true, evidenceImageUrls: true } },
    },
  });
  const ids = cases.map((record) => record.id);
  const actions = ids.length ? await prisma.verificationAction.findMany({
    where: { caseId: { in: ids } },
    select: { caseId: true, actionType: true, createdAt: true },
  }) : [];
  const verified = cases.filter((record) => record.status === 'VERIFIED');
  const reopened = cases.filter((record) => record.status === 'REOPENED');
  const terminalCount = verified.length + reopened.length;
  const citizenConfirmed = actions.filter((action) => action.actionType === 'CITIZEN_CONFIRMED').length;
  const disputedCount = cases.filter((record) => record.citizenDecision !== null && record.citizenDecision !== 'CONFIRM').length;
  const respondedCount = cases.filter((record) => record.citizenDecision !== null).length;
  const pendingCount = cases.filter((record) => record.status === 'PENDING').length;
  const overdueCount = cases.filter((record) =>
    (record.status === 'PENDING' && record.responseDeadline <= new Date())
    || (record.status === 'REVIEW_REQUIRED' && Boolean(record.reviewDueAt && record.reviewDueAt <= new Date()))
    || (record.status === 'DISPUTED' && (
      Boolean(record.escalationAt && record.escalationAt <= new Date())
      || Boolean(record.reviewDueAt && record.reviewDueAt <= new Date())
    )),
  ).length;
  const completeEvidenceCount = cases.filter((record) =>
    record.resolutionEvidence.evidenceDescription.trim().length > 0
    && Boolean(record.resolutionEvidence.workCompleted?.trim())
    && record.resolutionEvidence.evidenceImageUrls.length > 0,
  ).length;
  const verificationDurations = verified.flatMap((record) => {
    const confirmation = actions.find((action) =>
      action.caseId === record.id && ['CITIZEN_CONFIRMED', 'REVIEW_CONFIRMED'].includes(action.actionType),
    );
    return confirmation ? [confirmation.createdAt.getTime() - record.createdAt.getTime()] : [];
  });
  const resolutionDurations = verified.flatMap((record) =>
    record.incident.resolvedAt ? [record.incident.resolvedAt.getTime() - record.incident.createdAt.getTime()] : [],
  );
  const averageHours = (values: number[]) =>
    values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length / 3_600_000) : null;

  return {
    department: { id: department.id, name: department.name },
    metrics: {
      requiringVerification: cases.length,
      citizenConfirmedResolutions: citizenConfirmed,
      disputedResolutions: disputedCount,
      reopenedIncidents: reopened.length,
      verifiedResolutions: verified.length,
      verificationSuccessRate: terminalCount ? Math.round(verified.length / terminalCount * 100) : null,
      evidenceCompletenessRate: cases.length ? Math.round(completeEvidenceCount / cases.length * 100) : null,
      averageTimeToVerificationHours: averageHours(verificationDurations),
      averageTimeToResolveVerifiedHours: averageHours(resolutionDurations),
      disputeRate: respondedCount ? Math.round(disputedCount / respondedCount * 100) : null,
      reopenRate: terminalCount ? Math.round(reopened.length / terminalCount * 100) : null,
      pendingVerification: pendingCount,
      overdueVerification: overdueCount,
    },
    trustIndicator: terminalCount < 5
      ? { label: 'Insufficient data', sampleSize: terminalCount, minimumSampleSize: 5 }
      : {
        label: 'Verified outcome rate',
        value: Math.round(verified.length / terminalCount * 100),
        unit: 'percent',
        sampleSize: terminalCount,
        basis: 'Verified outcomes divided by verified plus reopened final decisions. Open cases and citizen silence are excluded; this is not a department ranking.',
      },
    limitations: [
      'Only cases with a final verified or reopened decision contribute to the trust indicator.',
      'Citizen silence is never counted as approval or as a failed outcome.',
      'Evidence completeness means a written description, work-completed field, and at least one resolution image are present; it does not measure evidence truthfulness.',
      'Time averages use cases with a recorded verification or verified resolution timestamp only.',
    ],
  };
}
