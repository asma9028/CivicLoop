import { IncidentStatus, Prisma, type RecommendationStatus, type UserRole, type VerificationActionType } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { intelligenceConfig } from '../config/intelligence.js';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  buildRecommendations,
  buildResolutionTrend,
  comparePeriods,
  detectHotspots,
  findRecurringIssues,
  isValidRecommendationTransition,
  statusIsOpen,
  summarizeIntelligence,
  validateIncidentCoordinates,
  type IntelligenceIncident,
  type IntelligencePeriod,
} from '../services/intelligence/engine.js';
import { summarizeCityIntelligence } from '../services/intelligence/summary.js';
import { logSafeError } from '../utils/safe-logger.js';

export const intelligenceRouter = Router();

const incidentLimit = 5_000;
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const querySchema = z.object({
  period: z.enum(['7d', '30d', '90d', '6m', '12m', 'custom']).default('30d'),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  departmentId: z.string().min(1).max(64).optional(),
  category: z.enum(['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER']).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
}).strict().superRefine((value, context) => {
  if (value.period === 'custom' && (!value.from || !value.to)) {
    context.addIssue({ code: 'custom', path: ['from'], message: 'Custom periods require both start and end dates' });
  }
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'The end date must be on or after the start date' });
  }
});
const recommendationListSchema = pageSchema.extend({
  status: z.enum(['PENDING', 'ACCEPTED', 'DISMISSED', 'IN_PROGRESS', 'COMPLETED']).optional(),
  departmentId: z.string().min(1).max(64).optional(),
}).strict();
const recommendationPatchSchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'DISMISSED', 'IN_PROGRESS', 'COMPLETED']).optional(),
  responsibleDepartmentId: z.string().min(1).max(64).nullable().optional(),
  reason: z.string().trim().min(10).max(2_000).optional(),
  actionSummary: z.string().trim().min(10).max(2_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one recommendation update is required').superRefine((value, context) => {
  if (value.status === 'DISMISSED' && !value.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Dismissal requires a meaningful reason' });
  }
  if (value.status === 'COMPLETED' && !value.actionSummary) {
    context.addIssue({ code: 'custom', path: ['actionSummary'], message: 'Completion requires a meaningful action summary' });
  }
});

const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });

type IntelligenceQuery = z.infer<typeof querySchema>;
type DepartmentScope = { ok: true; departmentId?: string } | { ok: false; status: number; error: string };

function getId(req: Request) {
  return typeof req.params.id === 'string' ? req.params.id : null;
}

function responseError(res: Response, error: unknown, message: string, status = 503) {
  if (error instanceof Error && error.message === 'Recommendation changed during update') {
    return res.status(409).json({ error: error.message });
  }
  logSafeError('intelligence.request', error, res.getHeader('X-Request-Id'));
  return res.status(status).json({ error: message });
}

function resolvePeriod(query: IntelligenceQuery, now = new Date()): IntelligencePeriod {
  if (query.period === 'custom') {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T23:59:59.999Z`);
    return { from, to };
  }
  const end = now;
  const start = new Date(now);
  switch (query.period) {
    case '7d': start.setUTCDate(start.getUTCDate() - 7); break;
    case '30d': start.setUTCDate(start.getUTCDate() - 30); break;
    case '90d': start.setUTCDate(start.getUTCDate() - 90); break;
    case '6m': start.setUTCMonth(start.getUTCMonth() - 6); break;
    case '12m': start.setUTCMonth(start.getUTCMonth() - 12); break;
  }
  return { from: start, to: end };
}

function previousPeriod(period: IntelligencePeriod): IntelligencePeriod {
  const duration = period.to.getTime() - period.from.getTime() + 1;
  return {
    from: new Date(period.from.getTime() - duration),
    to: new Date(period.from.getTime() - 1),
  };
}

async function authorizeDepartment(role: UserRole, userId: string, requestedDepartmentId?: string): Promise<DepartmentScope> {
  if (role === 'AUTHORITY') {
    const profile = await prisma.authorityProfile.findUnique({
      where: { userId },
      select: { departmentId: true, department: { select: { status: true } } },
    });
    if (!profile || profile.department.status !== 'ACTIVE') return { ok: false, status: 403, error: 'An active department assignment is required' };
    if (requestedDepartmentId && requestedDepartmentId !== profile.departmentId) return { ok: false, status: 403, error: 'You do not have access to that department' };
    return { ok: true, departmentId: profile.departmentId };
  }
  if (requestedDepartmentId) {
    const department = await prisma.department.findUnique({ where: { id: requestedDepartmentId }, select: { id: true } });
    if (!department) return { ok: false, status: 404, error: 'Department not found' };
  }
  return { ok: true, departmentId: requestedDepartmentId };
}

async function loadIncidents(options: {
  from: Date;
  to: Date;
  departmentId?: string;
  publicOnly?: boolean;
  category?: IntelligenceQuery['category'];
  severity?: IntelligenceQuery['severity'];
}) {
  const where: Prisma.IncidentWhereInput = {
    createdAt: { gte: options.from, lte: options.to },
    ...(options.departmentId ? { departmentId: options.departmentId } : {}),
    ...(options.publicOnly ? { isPublic: true } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.severity ? { severity: options.severity } : {}),
  };
  const [incidents, total] = await prisma.$transaction([
    prisma.incident.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: incidentLimit,
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        status: true,
        latitude: true,
        longitude: true,
        createdAt: true,
        resolvedAt: true,
        departmentId: true,
        department: { select: { name: true } },
        duplicateOfIncidentId: true,
        activities: { where: { newStatus: IncidentStatus.REOPENED }, select: { id: true } },
        verificationCases: {
          select: {
            status: true,
            actions: {
              where: { actionType: { in: ['CITIZEN_DISPUTED', 'REVIEW_REOPENED'] as VerificationActionType[] } },
              select: { actionType: true },
            },
          },
        },
      },
    }),
    prisma.incident.count({ where }),
  ]);
  const valid = incidents.filter((incident) => validateIncidentCoordinates(incident.latitude, incident.longitude));
  const mapped: IntelligenceIncident[] = valid.map((incident) => ({
    id: incident.id,
    title: incident.title,
    category: incident.category,
    severity: incident.severity,
    status: incident.status,
    latitude: incident.latitude,
    longitude: incident.longitude,
    createdAt: incident.createdAt,
    resolvedAt: incident.resolvedAt,
    departmentId: incident.departmentId,
    departmentName: incident.department?.name ?? null,
    duplicateOfIncidentId: incident.duplicateOfIncidentId,
    reopenCount: incident.activities.length + incident.verificationCases.flatMap((item) => item.actions)
      .filter((action) => action.actionType === 'REVIEW_REOPENED').length,
    disputeCount: incident.verificationCases.filter((item) => item.status === 'DISPUTED' || item.status === 'REVIEW_REQUIRED').length
      + incident.verificationCases.flatMap((item) => item.actions).filter((action) => action.actionType === 'CITIZEN_DISPUTED').length,
    verificationStatuses: incident.verificationCases.map((item) => item.status),
    verifiedCount: incident.verificationCases.filter((item) => item.status === 'VERIFIED').length,
  }));
  return { incidents: mapped, total, truncated: total > incidentLimit, invalidCoordinateCount: incidents.length - valid.length };
}

function filterPeriod(incidents: IntelligenceIncident[], period: IntelligencePeriod) {
  return incidents.filter((incident) => incident.createdAt >= period.from && incident.createdAt <= period.to);
}

function periodMetrics(incidents: IntelligenceIncident[]) {
  const byDepartment = new Map<string, {
    departmentId: string;
    departmentName: string;
    total: number;
    open: number;
    overdue: number;
    resolved: number;
    reopened: number;
    disputed: number;
    verified: number;
  }>();
  const now = Date.now();
  for (const incident of incidents) {
    if (!incident.departmentId || !incident.departmentName) continue;
    const value = byDepartment.get(incident.departmentId) ?? {
      departmentId: incident.departmentId,
      departmentName: incident.departmentName,
      total: 0,
      open: 0,
      overdue: 0,
      resolved: 0,
      reopened: 0,
      disputed: 0,
      verified: 0,
    };
    value.total += 1;
    if (statusIsOpen(incident.status)) {
      value.open += 1;
      if (now - incident.createdAt.getTime() >= intelligenceConfig.overdueHours * 3_600_000) value.overdue += 1;
    }
    if (incident.status === 'RESOLVED') value.resolved += 1;
    if (incident.status === 'REOPENED' || incident.reopenCount > 0) value.reopened += 1;
    value.disputed += incident.disputeCount;
    value.verified += incident.verifiedCount;
    byDepartment.set(incident.departmentId, value);
  }
  return [...byDepartment.values()].sort((a, b) => b.open - a.open || b.total - a.total);
}

async function getIntelligence(query: IntelligenceQuery, scope: { departmentId?: string }, publicOnly = false) {
  const period = resolvePeriod(query);
  const previous = previousPeriod(period);
  const start = previous.from < period.from ? previous.from : period.from;
  const [data, resolutionEvents] = await Promise.all([
    loadIncidents({
      from: start,
      to: period.to,
      departmentId: scope.departmentId,
      publicOnly,
      category: query.category,
      severity: query.severity,
    }),
    loadResolutionEvents(query, scope, period, publicOnly),
  ]);
  const currentIncidents = filterPeriod(data.incidents, period);
  const previousIncidents = filterPeriod(data.incidents, previous);
  const summary = summarizeIntelligence(currentIncidents, period, {
    minIncidents: intelligenceConfig.hotspotMinIncidents,
    radiusMeters: intelligenceConfig.hotspotRadiusMeters,
    overdueHours: intelligenceConfig.overdueHours,
  });
  const currentDepartments = periodMetrics(currentIncidents);
  const previousDepartments = periodMetrics(previousIncidents);
  const comparisons = {
    ...comparePeriods(currentIncidents, previousIncidents),
    periodDefinition: {
      currentStart: period.from.toISOString(),
      currentEnd: period.to.toISOString(),
      previousStart: previous.from.toISOString(),
      previousEnd: previous.to.toISOString(),
    },
    reopenedChange: currentIncidents.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length
      - previousIncidents.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length,
    disputeChange: currentIncidents.reduce((sum, item) => sum + item.disputeCount, 0)
      - previousIncidents.reduce((sum, item) => sum + item.disputeCount, 0),
    departmentWorkload: currentDepartments.map((department) => {
      const old = previousDepartments.find((item) => item.departmentId === department.departmentId);
      return {
        departmentId: department.departmentId,
        departmentName: department.departmentName,
        currentOpen: department.open,
        previousOpen: old?.open ?? 0,
        currentResolved: department.resolved,
        previousResolved: old?.resolved ?? 0,
      };
    }),
  };
  return {
    ...summary,
    comparisons,
    byDepartment: currentDepartments,
    resolutionTrend: buildResolutionTrend(resolutionEvents.eventDates, period),
    filters: {
      category: query.category ?? null,
      severity: query.severity ?? null,
      departmentId: scope.departmentId ?? null,
    },
    dataQuality: {
      totalIncidentsInRange: data.total,
      incidentsAnalyzed: data.incidents.length,
      truncated: data.truncated,
      resolutionTrendTruncated: resolutionEvents.truncated,
      invalidCoordinateCount: data.invalidCoordinateCount,
    },
  };
}

async function loadResolutionEvents(
  query: IntelligenceQuery,
  scope: { departmentId?: string },
  period: IntelligencePeriod,
  publicOnly: boolean,
) {
  const where: Prisma.IncidentWhereInput = {
    isPublic: publicOnly ? true : undefined,
    ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
  };
  const eventWhere: Prisma.IncidentActivityWhereInput = {
    newStatus: 'RESOLVED',
    createdAt: { gte: period.from, lte: period.to },
    incident: where,
  };
  const [incidents, total] = await prisma.$transaction([
    prisma.incidentActivity.findMany({
      where: eventWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: incidentLimit,
      select: { createdAt: true },
    }),
    prisma.incidentActivity.count({ where: eventWhere }),
  ]);
  return { eventDates: incidents.map((event) => event.createdAt), total, truncated: total > incidentLimit };
}

function publicInsights(intelligence: Awaited<ReturnType<typeof getIntelligence>>) {
  const publicHotspots = intelligence.hotspots
    .filter((hotspot) => hotspot.incidentCount >= intelligenceConfig.publicHotspotMinIncidents);
  const publicRecurrences = intelligence.recurrences
    .filter((recurrence) => recurrence.incidentCount >= intelligenceConfig.publicHotspotMinIncidents);
  return {
    period: intelligence.period,
    metrics: {
      totalReported: intelligence.metrics.totalReported,
      open: intelligence.metrics.open,
      resolved: intelligence.metrics.resolved,
      verifiedResolutions: intelligence.metrics.verifiedResolutions,
      disputedResolutions: intelligence.metrics.disputedResolutions,
      reopenedIncidents: intelligence.metrics.reopenedIncidents,
      overdueUnresolved: intelligence.metrics.overdueUnresolved,
      verificationSuccessRate: intelligence.metrics.verificationSuccessRate,
      recurringIssueCount: publicRecurrences.length,
      emergingHotspotCount: publicHotspots.filter((hotspot) => hotspot.trend.length > 1).length,
    },
    byCategory: intelligence.byCategory,
    monthlyTrend: intelligence.monthlyTrend,
    resolutionTrend: intelligence.resolutionTrend,
    comparisons: {
      currentReports: intelligence.comparisons.currentReports,
      previousReports: intelligence.comparisons.previousReports,
      reportChangePercent: intelligence.comparisons.reportChangePercent,
      reportChangeDescription: intelligence.comparisons.reportChangeDescription,
      categoryTrends: intelligence.comparisons.categoryTrends,
    },
    hotspots: publicHotspots.map((hotspot) => ({
        id: hotspot.id,
        latitude: Math.round(hotspot.latitude * 100) / 100,
        longitude: Math.round(hotspot.longitude * 100) / 100,
        incidentCount: hotspot.incidentCount,
        dominantCategory: hotspot.dominantCategory,
        severityDistribution: hotspot.severityDistribution,
        riskScore: hotspot.riskScore,
        riskLevel: hotspot.riskLevel,
        reopenedIncidents: hotspot.reopenedIncidents,
        verifiedResolutions: hotspot.verifiedResolutions,
        unresolvedIncidents: hotspot.unresolvedIncidents,
        departmentName: hotspot.department?.name ?? null,
      })),
    recurrences: publicRecurrences.map((recurrence) => ({
        id: recurrence.id,
        category: recurrence.category,
        approximateLatitude: Math.round(recurrence.latitude * 100) / 100,
        approximateLongitude: Math.round(recurrence.longitude * 100) / 100,
        incidentCount: recurrence.incidentCount,
        reopenedIncidents: recurrence.reopenedIncidents,
        averageRecurrenceDays: recurrence.averageRecurrenceDays,
      })),
    dataLimitations: [
      ...intelligence.dataLimitations,
      'Incident metrics and comparisons use incident creation dates; the resolution trend counts recorded transitions to RESOLVED by transition date.',
      `Public hotspots and recurrence groups require at least ${intelligenceConfig.publicHotspotMinIncidents} public reports and use rounded approximate coordinates.`,
      'Public insights omit incident titles, descriptions, exact coordinates, personal data, and internal recommendations.',
    ],
    dataQuality: {
      incidentsAnalyzed: intelligence.dataQuality.incidentsAnalyzed,
      truncated: intelligence.dataQuality.truncated,
      resolutionTrendTruncated: intelligence.dataQuality.resolutionTrendTruncated,
    },
  };
}

function recommendationWhere(role: UserRole, departmentId?: string, status?: RecommendationStatus): Prisma.ProactiveRecommendationWhereInput {
  return {
    ...(departmentId ? { responsibleDepartmentId: departmentId } : role === 'AUTHORITY' ? { responsibleDepartmentId: '__no_department__' } : {}),
    ...(status ? { status } : {}),
  };
}

async function refreshRecommendations(actorId: string, departmentId?: string) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 90);
  const result = await loadIncidents({ from: start, to: end, departmentId });
  const summary = summarizeIntelligence(result.incidents, { from: start, to: end });
  const drafts = buildRecommendations(summary.hotspots);
  const generatedAt = new Date();
  const refreshed = await prisma.$transaction(async (tx) => {
    let created = 0;
    for (const draft of drafts) {
      const existing = await tx.proactiveRecommendation.findUnique({
        where: { recommendationKey: draft.recommendationKey },
        select: { id: true, riskScore: true, status: true, responsibleDepartmentId: true },
      });
      if (!existing) {
        const recommendation = await tx.proactiveRecommendation.create({
          data: {
            ...draft,
            supportingMetrics: draft.supportingMetrics,
            generatedAt,
            history: {
              create: {
                actorUserId: actorId,
                action: 'GENERATED',
                newStatus: 'PENDING',
                metadata: { incidentSampleSize: result.incidents.length, truncated: result.truncated },
              },
            },
          },
        });
        void recommendation;
        created += 1;
      } else {
        const scoreChanged = existing.riskScore !== draft.riskScore;
        await tx.proactiveRecommendation.update({
          where: { id: existing.id },
          data: {
            title: draft.title,
            description: draft.description,
            areaLabel: draft.areaLabel,
            latitude: draft.latitude,
            longitude: draft.longitude,
            category: draft.category,
            riskScore: draft.riskScore,
            priority: draft.priority,
            supportingMetrics: draft.supportingMetrics,
            recommendedAction: draft.recommendedAction,
            generatedAt,
            ...(existing.responsibleDepartmentId ? {} : { responsibleDepartmentId: draft.responsibleDepartmentId }),
          },
        });
        if (scoreChanged) await tx.recommendationHistory.create({
          data: {
            recommendationId: existing.id,
            actorUserId: actorId,
            action: 'METRICS_REFRESHED',
            previousStatus: existing.status,
            newStatus: existing.status,
            metadata: { previousRiskScore: existing.riskScore, riskScore: draft.riskScore },
          },
        });
      }
    }
    return { generated: drafts.length, created, truncated: result.truncated, sampleSize: result.incidents.length };
  });
  return refreshed;
}

intelligenceRouter.get('/public', readLimiter, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid city insight filters', fields: parsed.error.flatten().fieldErrors });
  try {
    const intelligence = await getIntelligence(parsed.data, {}, true);
    return res.json({ intelligence: publicInsights(intelligence) });
  } catch (error) {
    return responseError(res, error, 'Public city insights are temporarily unavailable');
  }
});

intelligenceRouter.use(requireAuth);
intelligenceRouter.get('/overview', readLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid city intelligence filters', fields: parsed.error.flatten().fieldErrors });
  try {
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const intelligence = await getIntelligence(parsed.data, scope);
    return res.json({
      intelligence,
      weights: intelligenceConfig.riskWeights,
      methodology: {
        hotspotRadiusMeters: intelligenceConfig.hotspotRadiusMeters,
        hotspotMinimumReports: intelligenceConfig.hotspotMinIncidents,
        recurrenceRadiusMeters: intelligenceConfig.recurrenceRadiusMeters,
        recurrenceWindowDays: intelligenceConfig.recurrenceWindowDays,
        overdueHours: intelligenceConfig.overdueHours,
        riskScale: '0-100',
        riskWeights: intelligenceConfig.riskWeights,
        riskCategories: { low: '0-34', moderate: '35-54', high: '55-74', critical: '75-100' },
        scoreFeatures: {
          density: 'min(incident count / 10, 1) × 100',
          severity: 'Mean severity points: LOW 20, MEDIUM 45, HIGH 70, CRITICAL 100',
          recurrence: 'min(recurring issue groups / 5, 1) × 100',
          overdue: 'min(overdue open reports / max(incident count × 0.5, 1), 1) × 100',
          disputeReopen: 'min((disputed resolutions + reopened incidents) / max(incident count × 0.5, 1), 1) × 100',
        },
        caveat: 'Risk scores describe observed civic-service data and do not establish cause, future events, or individual performance.',
      },
    });
  } catch (error) {
    return responseError(res, error, 'City intelligence is temporarily unavailable');
  }
});

intelligenceRouter.get('/hotspots', readLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid hotspot filters' });
  try {
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const intelligence = await getIntelligence(parsed.data, scope);
    return res.json({ hotspots: intelligence.hotspots, dataQuality: intelligence.dataQuality });
  } catch (error) {
    return responseError(res, error, 'Hotspot analysis is temporarily unavailable');
  }
});

intelligenceRouter.get('/recurrences', readLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recurrence filters' });
  try {
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const period = resolvePeriod(parsed.data);
    const data = await loadIncidents({
      from: period.from,
      to: period.to,
      departmentId: scope.departmentId,
      category: parsed.data.category,
      severity: parsed.data.severity,
    });
    return res.json({
      recurrences: findRecurringIssues(data.incidents),
      dataQuality: { totalIncidentsInRange: data.total, incidentsAnalyzed: data.incidents.length, truncated: data.truncated },
    });
  } catch (error) {
    return responseError(res, error, 'Recurrence analysis is temporarily unavailable');
  }
});

intelligenceRouter.post('/summary', aiLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = querySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid city intelligence filters' });
  try {
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const intelligence = await getIntelligence(parsed.data, scope);
    const result = await summarizeCityIntelligence({
      period: intelligence.period,
      metrics: intelligence.metrics,
      byCategory: intelligence.byCategory,
      bySeverity: intelligence.bySeverity,
      byStatus: intelligence.byStatus,
      comparisons: {
        currentReports: intelligence.comparisons.currentReports,
        previousReports: intelligence.comparisons.previousReports,
        reportChangePercent: intelligence.comparisons.reportChangePercent,
        reportChangeDescription: intelligence.comparisons.reportChangeDescription,
        categoryTrends: intelligence.comparisons.categoryTrends,
        reopenedChange: intelligence.comparisons.reopenedChange,
        disputeChange: intelligence.comparisons.disputeChange,
      },
      hotspots: intelligence.hotspots.map((hotspot) => ({
        incidentCount: hotspot.incidentCount,
        dominantCategory: hotspot.dominantCategory,
        categoryCounts: hotspot.categoryCounts,
        severityDistribution: hotspot.severityDistribution,
        trend: hotspot.trend,
        repeatedIssueCount: hotspot.repeatedIssueCount,
        reopenedIncidents: hotspot.reopenedIncidents,
        overdueIncidents: hotspot.overdueIncidents,
        disputedResolutions: hotspot.disputedResolutions,
        riskScore: hotspot.riskScore,
        riskLevel: hotspot.riskLevel,
      })),
      recurrences: intelligence.recurrences.map((recurrence) => ({
        category: recurrence.category,
        incidentCount: recurrence.incidentCount,
        independentReports: recurrence.independentReports,
        duplicateReports: recurrence.duplicateReports,
        reopenedIncidents: recurrence.reopenedIncidents,
        disputedResolutions: recurrence.disputedResolutions,
        verifiedResolutions: recurrence.verifiedResolutions,
        averageRecurrenceDays: recurrence.averageRecurrenceDays,
      })),
      dataLimitations: intelligence.dataLimitations,
    });
    return res.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    return responseError(res, error, 'City intelligence summary is temporarily unavailable');
  }
});

intelligenceRouter.get('/recommendations', readLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = recommendationListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recommendation filters' });
  try {
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const where = recommendationWhere(req.user!.role, scope.departmentId, parsed.data.status);
    const [recommendations, total] = await prisma.$transaction([
      prisma.proactiveRecommendation.findMany({
        where,
        include: {
          responsibleDepartment: { select: { id: true, name: true, code: true } },
          history: { orderBy: { createdAt: 'desc' }, take: 10, include: { actor: { select: { fullName: true, role: true } } } },
        },
        orderBy: [{ priority: 'desc' }, { riskScore: 'desc' }, { generatedAt: 'desc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.proactiveRecommendation.count({ where }),
    ]);
    return res.json({
      recommendations,
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return responseError(res, error, 'Recommendations are temporarily unavailable');
  }
});

intelligenceRouter.post('/recommendations/refresh', writeLimiter, requireRole('ADMIN'), async (req, res) => {
  const parsed = z.object({ departmentId: z.string().min(1).max(64).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recommendation generation scope' });
  try {
    if (parsed.data.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: parsed.data.departmentId }, select: { id: true, status: true } });
      if (!department) return res.status(404).json({ error: 'Department not found' });
      if (department.status !== 'ACTIVE') return res.status(409).json({ error: 'Recommendations can only be generated for an active department' });
    }
    const result = await refreshRecommendations(req.user!.id, parsed.data.departmentId);
    return res.json({ result });
  } catch (error) {
    return responseError(res, error, 'Unable to refresh proactive recommendations');
  }
});

intelligenceRouter.patch('/recommendations/:id', writeLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = recommendationPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recommendation update', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Recommendation not found' });
  try {
    const existing = await prisma.proactiveRecommendation.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Recommendation not found' });
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, existing.responsibleDepartmentId ?? undefined);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    if (req.user!.role === 'AUTHORITY' && scope.departmentId !== existing.responsibleDepartmentId) {
      return res.status(404).json({ error: 'Recommendation not found in your department' });
    }
    if (req.user!.role === 'AUTHORITY' && parsed.data.responsibleDepartmentId !== undefined) {
      return res.status(403).json({ error: 'Only administrators can assign recommendations to a department' });
    }
    if (parsed.data.status && !isValidRecommendationTransition(existing.status, parsed.data.status)) {
      return res.status(409).json({ error: `Cannot change a recommendation from ${existing.status} to ${parsed.data.status}` });
    }
    if (parsed.data.responsibleDepartmentId) {
      const department = await prisma.department.findUnique({
        where: { id: parsed.data.responsibleDepartmentId },
        select: { id: true, status: true },
      });
      if (!department || department.status !== 'ACTIVE') return res.status(400).json({ error: 'Select an active department' });
    }
    const nextDepartmentId = parsed.data.responsibleDepartmentId === undefined
      ? existing.responsibleDepartmentId
      : parsed.data.responsibleDepartmentId;
    const changed = await prisma.$transaction(async (tx) => {
      const updated = await tx.proactiveRecommendation.updateMany({
        where: { id, status: existing.status, responsibleDepartmentId: existing.responsibleDepartmentId },
        data: {
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.responsibleDepartmentId !== undefined ? { responsibleDepartmentId: parsed.data.responsibleDepartmentId } : {}),
          ...(parsed.data.reason ? { dismissalReason: parsed.data.reason } : {}),
          ...(parsed.data.actionSummary ? { actionSummary: parsed.data.actionSummary } : {}),
        },
      });
      if (!updated.count) throw new Error('Recommendation changed during update');
      const action = parsed.data.status
        ? 'STATUS_CHANGED'
        : existing.responsibleDepartmentId !== nextDepartmentId
          ? 'ASSIGNED'
          : 'UPDATED';
      await tx.recommendationHistory.create({
        data: {
          recommendationId: id,
          actorUserId: req.user!.id,
          previousStatus: existing.status,
          newStatus: parsed.data.status ?? existing.status,
          action,
          reason: parsed.data.reason ?? parsed.data.actionSummary ?? null,
          metadata: {
            ...(existing.responsibleDepartmentId !== nextDepartmentId
              ? { previousDepartmentId: existing.responsibleDepartmentId, departmentId: nextDepartmentId }
              : {}),
          },
        },
      });
      return tx.proactiveRecommendation.findUnique({
        where: { id },
        include: { responsibleDepartment: { select: { id: true, name: true, code: true } } },
      });
    });
    return res.json({ recommendation: changed });
  } catch (error) {
    return responseError(res, error, 'Unable to update the recommendation');
  }
});

intelligenceRouter.get('/recommendations/:id/history', readLimiter, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Recommendation not found' });
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recommendation history page' });
  try {
    const recommendation = await prisma.proactiveRecommendation.findUnique({
      where: { id },
      select: { id: true, responsibleDepartmentId: true },
    });
    if (!recommendation) return res.status(404).json({ error: 'Recommendation not found' });
    const scope = await authorizeDepartment(req.user!.role, req.user!.id, recommendation.responsibleDepartmentId ?? undefined);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    if (req.user!.role === 'AUTHORITY' && recommendation.responsibleDepartmentId !== scope.departmentId) {
      return res.status(404).json({ error: 'Recommendation not found in your department' });
    }
    const [history, total] = await prisma.$transaction([
      prisma.recommendationHistory.findMany({
        where: { recommendationId: id },
        include: { actor: { select: { fullName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.recommendationHistory.count({ where: { recommendationId: id } }),
    ]);
    return res.json({ history, pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) } });
  } catch (error) {
    return responseError(res, error, 'Recommendation history is temporarily unavailable');
  }
});
