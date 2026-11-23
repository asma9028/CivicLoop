import { IncidentStatus, Prisma, type IncidentCategory, type PriorityBand, type Severity, type UserRole } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isActiveWorkloadStatus, mergeTrendRows } from '../services/authority/analytics.js';
import { InvalidIncidentTransitionError, transitionIncident, validIncidentTransitions } from '../services/incidents/lifecycle.js';
import { verificationResponseHours } from '../config/verification.js';
import { logSafeError } from '../utils/safe-logger.js';

export const authorityRouter = Router();
authorityRouter.use(requireAuth, requireRole('AUTHORITY', 'ADMIN'));

const incidentStatuses = Object.values(IncidentStatus);
const categories: IncidentCategory[] = ['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER'];
const priorities: PriorityBand[] = ['P1', 'P2', 'P3', 'P4'];
const severities: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const actionableStatuses: IncidentStatus[] = ['REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'REOPENED'];
const verificationStatuses: IncidentStatus[] = ['RESOLUTION_SUBMITTED', 'VERIFICATION_PENDING'];
const nonTerminalStatuses = Object.values(IncidentStatus).filter(isActiveWorkloadStatus);
const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

function positiveHours(name: string, defaultValue: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 24 * 365) {
    throw new Error(`${name} must be a whole number between 1 and 8760`);
  }
  return value;
}

const overdueHours = positiveHours('AUTHORITY_OVERDUE_HOURS', 72);
const unacknowledgedHours = positiveHours('AUTHORITY_UNACKNOWLEDGED_HOURS', 24);
type DepartmentScope = { ok: true; departmentId: string | undefined } | { ok: false; error: string };

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(incidentStatuses as [IncidentStatus, ...IncidentStatus[]]).optional(),
  priority: z.enum(priorities as [PriorityBand, ...PriorityBand[]]).optional(),
  severity: z.enum(severities as [Severity, ...Severity[]]).optional(),
  category: z.enum(categories as [IncidentCategory, ...IncidentCategory[]]).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  assigned: z.enum(['all', 'assigned', 'unassigned', 'mine']).default('all'),
  assignedAuthorityId: z.string().min(1).max(64).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  sort: z.enum(['priority', 'newest', 'oldest', 'updated']).default('priority'),
  view: z.enum(['all', 'new', 'unassigned', 'critical', 'high-priority', 'in-progress', 'awaiting-verification', 'overdue']).default('all'),
}).strict();

const assignSchema = z.object({ assignedAuthorityId: z.string().min(1).max(64).optional() }).strict();
const assignmentPatchSchema = z.object({ assignedAuthorityId: z.string().min(1).max(64).nullable() }).strict();
const statusSchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'IN_PROGRESS', 'VERIFICATION_PENDING', 'ON_HOLD', 'REJECTED', 'DUPLICATE']),
  reason: z.string().trim().max(1_000).optional(),
  relatedIncidentId: z.string().min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  if (['ON_HOLD', 'REJECTED', 'DUPLICATE'].includes(value.status) && !value.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required for this status change' });
  }
  if (value.status === 'DUPLICATE' && !value.relatedIncidentId) {
    context.addIssue({ code: 'custom', path: ['relatedIncidentId'], message: 'Select the related incident' });
  }
  if (value.status !== 'DUPLICATE' && value.relatedIncidentId) {
    context.addIssue({ code: 'custom', path: ['relatedIncidentId'], message: 'A related incident is only valid for a duplicate' });
  }
});

const updateSchema = z.object({
  text: z.string().trim().min(3).max(2_000),
  visibility: z.enum(['PUBLIC', 'INTERNAL']).default('PUBLIC'),
}).strict();

const resolutionSchema = z.object({
  description: z.string().trim().min(10).max(2_000),
  workCompleted: z.string().trim().min(10).max(2_000),
  resolutionDate: z.string().date().optional(),
  notes: z.string().trim().max(2_000).optional(),
  imageUrls: z.array(z.string().regex(/^\/api\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/i))
    .max(5)
    .refine((urls) => new Set(urls).size === urls.length, 'Duplicate evidence references are not allowed')
    .default([]),
}).strict();

const analyticsQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  departmentId: z.string().min(1).max(64).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'The start date must be on or before the end date',
});

function queryValue(req: Request, key: string) {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function getId(req: Request) {
  const id = req.params.id;
  return typeof id === 'string' ? id : null;
}

function dateRange(from?: string, to?: string) {
  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) {
    const exclusive = new Date(`${to}T00:00:00.000Z`);
    exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    createdAt.lt = exclusive;
  }
  return Object.keys(createdAt).length ? createdAt : undefined;
}

async function departmentScope(role: UserRole, userId: string, requestedDepartmentId?: string) {
  if (role === 'AUTHORITY') {
    const profile = await prisma.authorityProfile.findUnique({
      where: { userId },
      include: { department: { select: { id: true, status: true } } },
    });
    if (!profile || profile.department.status !== 'ACTIVE') return { ok: false, error: 'An active authority department assignment is required' } as const;
    if (requestedDepartmentId && requestedDepartmentId !== profile.departmentId) return { ok: false, error: 'You do not have access to that department' } as const;
    return { ok: true, departmentId: profile.departmentId } as const;
  }
  if (requestedDepartmentId) {
    const department = await prisma.department.findUnique({ where: { id: requestedDepartmentId }, select: { id: true } });
    if (!department) return { ok: false, error: 'Department not found' } as const;
  }
  return { ok: true, departmentId: requestedDepartmentId } as const;
}

function responseError(res: Response, error: unknown, message: string, status = 503) {
  logSafeError('authority.request', error, res.getHeader('X-Request-Id'));
  res.status(status).json({ error: message });
}

function aggregateCount(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && '_all' in value && typeof value._all === 'number') return value._all;
  return 0;
}

function activeViewWhere(view: z.infer<typeof listQuerySchema>['view'], now = new Date()): Prisma.IncidentWhereInput {
  switch (view) {
    case 'new':
      return { status: 'REPORTED' };
    case 'unassigned':
      return { assignedAuthorityId: null, status: { in: actionableStatuses } };
    case 'critical':
      return { severity: 'CRITICAL', status: { in: actionableStatuses } };
    case 'high-priority':
      return { priorityBand: { in: ['P1', 'P2'] }, status: { in: actionableStatuses } };
    case 'in-progress':
      return { status: 'IN_PROGRESS' };
    case 'awaiting-verification':
      return { status: { in: verificationStatuses } };
    case 'overdue': {
      const deadline = new Date(now.getTime() - overdueHours * 60 * 60 * 1000);
      return { status: { in: actionableStatuses }, createdAt: { lt: deadline } };
    }
    default:
      return {};
  }
}

function priorityOrder(): Prisma.IncidentOrderByWithRelationInput[] {
  return [
    { priorityBand: 'asc' },
    { priorityScore: 'desc' },
    { severity: 'desc' },
    { status: 'asc' },
    { createdAt: 'asc' },
  ];
}

const queueSelect = {
  id: true,
  title: true,
  description: true,
  category: true,
  subcategory: true,
  locationText: true,
  status: true,
  severity: true,
  priorityBand: true,
  priorityScore: true,
  createdAt: true,
  updatedAt: true,
  acknowledgedAt: true,
  assignedAt: true,
  department: { select: { id: true, name: true, code: true } },
  assignedAuthority: { select: { id: true, fullName: true } },
} satisfies Prisma.IncidentSelect;

authorityRouter.get('/dashboard', async (req, res) => {
  try {
    const scope = await departmentScope(req.user!.role, req.user!.id);
    if (!scope.ok) return res.status(403).json({ error: scope.error });
    const where: Prisma.IncidentWhereInput = scope.departmentId ? { departmentId: scope.departmentId } : {};
    const now = new Date();
    const overdueWhere: Prisma.IncidentWhereInput = {
      ...where,
      status: { in: actionableStatuses },
      createdAt: { lt: new Date(now.getTime() - overdueHours * 60 * 60 * 1000) },
    };
    const noAcknowledgmentWhere: Prisma.IncidentWhereInput = {
      ...where,
      status: 'REPORTED',
      createdAt: { lt: new Date(now.getTime() - unacknowledgedHours * 60 * 60 * 1000) },
    };
    const [newCount, inProgressCount, verificationCount, overdueCount, resolvedCount, statusGroups, priorityGroups,
      assignedCount, unassignedCount, priorityQueue, recent, overdueIncidents, unacknowledgedCount, criticalCount,
      highPriorityCount, resolvedForAverage] = await prisma.$transaction([
      prisma.incident.count({ where: { ...where, status: 'REPORTED' } }),
      prisma.incident.count({ where: { ...where, status: 'IN_PROGRESS' } }),
      prisma.incident.count({ where: { ...where, status: { in: verificationStatuses } } }),
      prisma.incident.count({ where: overdueWhere }),
      prisma.incident.count({ where: { ...where, status: 'RESOLVED' } }),
      prisma.incident.groupBy({ by: ['status'], where, orderBy: { status: 'asc' }, _count: { _all: true } }),
      prisma.incident.groupBy({ by: ['priorityBand'], where, orderBy: { priorityBand: 'asc' }, _count: { _all: true } }),
      prisma.incident.count({ where: { ...where, status: { in: actionableStatuses }, assignedAuthorityId: { not: null } } }),
      prisma.incident.count({ where: { ...where, status: { in: actionableStatuses }, assignedAuthorityId: null } }),
      prisma.incident.findMany({
        where: { ...where, status: { in: actionableStatuses } },
        orderBy: priorityOrder(),
        take: 8,
        select: queueSelect,
      }),
      prisma.incident.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 8, select: queueSelect }),
      prisma.incident.findMany({
        where: overdueWhere,
        orderBy: [{ priorityBand: 'asc' }, { createdAt: 'asc' }],
        take: 5,
        select: queueSelect,
      }),
      prisma.incident.count({ where: noAcknowledgmentWhere }),
      prisma.incident.count({ where: { ...where, severity: 'CRITICAL', status: { in: actionableStatuses } } }),
      prisma.incident.count({ where: { ...where, priorityBand: { in: ['P1', 'P2'] }, status: { in: actionableStatuses } } }),
      prisma.incident.findMany({
        where: { ...where, status: 'RESOLVED', resolvedAt: { not: null } },
        orderBy: { resolvedAt: 'desc' },
        take: 500,
        select: { createdAt: true, resolvedAt: true },
      }),
    ]);
    const resolutionHours = resolvedForAverage.map((item) => (item.resolvedAt!.getTime() - item.createdAt.getTime()) / 3_600_000);
    const averageResolutionHours = resolutionHours.length >= 3
      ? Math.round(resolutionHours.reduce((sum, value) => sum + value, 0) / resolutionHours.length * 10) / 10
      : null;
    res.json({
      kpis: {
        new: newCount,
        awaitingAcknowledgment: newCount,
        inProgress: inProgressCount,
        awaitingVerification: verificationCount,
        overdue: overdueCount,
        resolved: resolvedCount,
      },
      priorityQueue,
      recentlyUpdated: recent,
      alerts: {
        critical: criticalCount,
        highPriority: highPriorityCount,
        overdue: overdueIncidents,
        unacknowledged: unacknowledgedCount,
      },
      workload: {
        open: statusGroups.filter((item) => !['RESOLVED', 'REJECTED', 'DUPLICATE'].includes(item.status)).reduce((sum, item) => sum + aggregateCount(item._count), 0),
        byStatus: Object.fromEntries(statusGroups.map((item) => [item.status, aggregateCount(item._count)])),
        byPriority: Object.fromEntries(priorityGroups.map((item) => [item.priorityBand, aggregateCount(item._count)])),
        assigned: assignedCount,
        unassigned: unassignedCount,
        averageResolutionHours,
        resolutionSampleSize: resolutionHours.length,
      },
      thresholds: { overdueHours, unacknowledgedHours },
    });
  } catch (error) {
    responseError(res, error, 'Authority dashboard is temporarily unavailable');
  }
});

authorityRouter.get('/profile', async (req, res) => {
  if (req.user!.role === 'ADMIN') return res.json({ profile: null, administratorAccess: true });
  try {
    const profile = await prisma.authorityProfile.findUnique({
      where: { userId: req.user!.id },
      include: { department: { select: { id: true, name: true, code: true, status: true } } },
    });
    if (!profile || profile.department.status !== 'ACTIVE') return res.status(403).json({ error: 'An active authority department assignment is required' });
    res.json({
      profile: {
        designation: profile.designation,
        employeeIdentifier: profile.employeeIdentifier,
        department: profile.department,
      },
    });
  } catch (error) {
    responseError(res, error, 'Unable to load authority profile');
  }
});

authorityRouter.get('/incidents', async (req, res) => {
  const rawQuery = {
    page: queryValue(req, 'page'),
    limit: queryValue(req, 'limit'),
    search: queryValue(req, 'search'),
    status: queryValue(req, 'status'),
    priority: queryValue(req, 'priority'),
    severity: queryValue(req, 'severity'),
    category: queryValue(req, 'category'),
    from: queryValue(req, 'from'),
    to: queryValue(req, 'to'),
    assigned: queryValue(req, 'assigned'),
    assignedAuthorityId: queryValue(req, 'assignedAuthorityId'),
    departmentId: queryValue(req, 'departmentId'),
    sort: queryValue(req, 'sort'),
    view: queryValue(req, 'view'),
  };
  const parsed = listQuerySchema.safeParse(Object.fromEntries(Object.entries(rawQuery).filter(([, value]) => value !== undefined)));
  if (!parsed.success) return res.status(400).json({ error: 'Invalid incident filters', fields: parsed.error.flatten().fieldErrors });
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    return res.status(400).json({ error: 'The start date must be on or before the end date' });
  }
  try {
    const scope = await departmentScope(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(403).json({ error: scope.error });
    const timeFilter = dateRange(parsed.data.from, parsed.data.to);
    const where: Prisma.IncidentWhereInput = {
      ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.priority ? { priorityBand: parsed.data.priority } : {}),
      ...(parsed.data.severity ? { severity: parsed.data.severity } : {}),
      ...(parsed.data.category ? { category: parsed.data.category } : {}),
      ...(timeFilter ? { createdAt: timeFilter } : {}),
      ...(parsed.data.search ? {
        OR: [
          { title: { contains: parsed.data.search, mode: 'insensitive' } },
          { description: { contains: parsed.data.search, mode: 'insensitive' } },
          { locationText: { contains: parsed.data.search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const conjunctions: Prisma.IncidentWhereInput[] = [];
    const viewWhere = activeViewWhere(parsed.data.view);
    if (Object.keys(viewWhere).length) conjunctions.push(viewWhere);
    if (parsed.data.assigned === 'unassigned') conjunctions.push({ assignedAuthorityId: null });
    if (parsed.data.assigned === 'assigned') conjunctions.push({ assignedAuthorityId: { not: null } });
    if (parsed.data.assigned === 'mine') conjunctions.push({ assignedAuthorityId: req.user!.id });
    if (parsed.data.assignedAuthorityId) conjunctions.push({ assignedAuthorityId: parsed.data.assignedAuthorityId });
    if (conjunctions.length) where.AND = conjunctions;

    const orderBy: Prisma.IncidentOrderByWithRelationInput | Prisma.IncidentOrderByWithRelationInput[] =
      parsed.data.sort === 'priority' ? priorityOrder()
        : parsed.data.sort === 'oldest' ? { createdAt: 'asc' }
          : parsed.data.sort === 'updated' ? { updatedAt: 'desc' }
            : { createdAt: 'desc' };
    const [items, total] = await prisma.$transaction([
      prisma.incident.findMany({
        where,
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
        orderBy,
        select: queueSelect,
      }),
      prisma.incident.count({ where }),
    ]);
    res.json({
      incidents: items,
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
      filters: { overdueHours },
    });
  } catch (error) {
    responseError(res, error, 'Incident queue is temporarily unavailable');
  }
});

authorityRouter.get('/analytics', async (req, res) => {
  const parsed = analyticsQuerySchema.safeParse(Object.fromEntries(
    ['from', 'to', 'departmentId'].map((key) => [key, queryValue(req, key)]).filter(([, value]) => value !== undefined),
  ));
  if (!parsed.success) return res.status(400).json({ error: 'Invalid analytics filters', fields: parsed.error.flatten().fieldErrors });
  try {
    const scope = await departmentScope(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(403).json({ error: scope.error });
    const timeFilter = dateRange(parsed.data.from, parsed.data.to);
    const where: Prisma.IncidentWhereInput = {
      ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
      ...(timeFilter ? { createdAt: timeFilter } : {}),
    };
    const activeWorkloadWhere: Prisma.IncidentWhereInput = {
      ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
      status: { in: nonTerminalStatuses },
    };
    const resolvedDateRange = dateRange(parsed.data.from, parsed.data.to);
    const [total, open, resolved, overdue, statusGroups, categoryGroups, priorityGroups, authorityProfiles, assignedGroups, timingRows, weekly, monthly] =
      await Promise.all([
        prisma.incident.count({ where }),
        prisma.incident.count({ where: { ...where, status: { notIn: ['RESOLVED', 'REJECTED', 'DUPLICATE'] } } }),
        prisma.incidentActivity.count({
          where: {
            newStatus: 'RESOLVED',
            ...(resolvedDateRange ? { createdAt: resolvedDateRange } : {}),
            ...(scope.departmentId ? { incident: { departmentId: scope.departmentId } } : {}),
          },
        }),
        prisma.incident.count({
          where: {
            ...where,
            status: { in: actionableStatuses },
            createdAt: { lt: new Date(Date.now() - overdueHours * 60 * 60 * 1000) },
          },
        }),
        prisma.incident.groupBy({ by: ['status'], where, orderBy: { status: 'asc' }, _count: { _all: true } }),
        prisma.incident.groupBy({ by: ['category'], where, orderBy: { category: 'asc' }, _count: { _all: true } }),
        prisma.incident.groupBy({ by: ['priorityBand'], where, orderBy: { priorityBand: 'asc' }, _count: { _all: true } }),
        prisma.authorityProfile.findMany({
          where: {
            user: { role: 'AUTHORITY' },
            ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
          },
          select: { userId: true, user: { select: { fullName: true, accountStatus: true } } },
          orderBy: { user: { fullName: 'asc' } },
        }),
        prisma.incident.groupBy({ by: ['assignedAuthorityId'], where: activeWorkloadWhere, orderBy: { assignedAuthorityId: 'asc' }, _count: { _all: true } }),
        prisma.incident.findMany({
          where,
          select: { createdAt: true, acknowledgedAt: true, status: true, resolvedAt: true },
          take: 20_000,
          orderBy: { createdAt: 'desc' },
        }),
        getTrend('week', scope.departmentId, parsed.data.from, parsed.data.to),
        getTrend('month', scope.departmentId, parsed.data.from, parsed.data.to),
      ]);
    const authorityLoad = authorityProfiles.map((profile) => ({
      authorityId: profile.userId,
      name: profile.user.fullName,
      active: profile.user.accountStatus === 'ACTIVE',
      assignedIncidents: aggregateCount(assignedGroups.find((group) => group.assignedAuthorityId === profile.userId)?._count),
    }));
    const acknowledgmentHours = timingRows
      .filter((item) => item.acknowledgedAt)
      .map((item) => (item.acknowledgedAt!.getTime() - item.createdAt.getTime()) / 3_600_000);
    const resolutionHours = timingRows
      .filter((item) => item.status === 'RESOLVED' && item.resolvedAt)
      .map((item) => (item.resolvedAt!.getTime() - item.createdAt.getTime()) / 3_600_000);
    const average = (values: number[]) => values.length >= 3
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10
      : null;
    res.json({
      metrics: {
        totalReports: total,
        open,
        resolved,
        overdue,
        averageAcknowledgmentHours: average(acknowledgmentHours),
        acknowledgmentSampleSize: acknowledgmentHours.length,
        averageResolutionHours: average(resolutionHours),
        resolutionSampleSize: resolutionHours.length,
        averageMetricsLimit: timingRows.length === 20_000,
      },
      byStatus: statusGroups.map(({ status, _count }) => ({ status, count: aggregateCount(_count) })),
      byCategory: categoryGroups.map(({ category, _count }) => ({ category, count: aggregateCount(_count) })),
      byPriority: priorityGroups.map(({ priorityBand, _count }) => ({ priorityBand, count: aggregateCount(_count) })),
      authorityWorkload: authorityLoad,
      weeklyTrend: weekly,
      monthlyTrend: monthly,
      thresholds: { overdueHours },
      dateRange: { from: parsed.data.from ?? null, to: parsed.data.to ?? null },
      dateSemantics: {
        reports: 'Report counts and status breakdowns use incident creation date.',
        resolved: 'Resolution counts and resolution trends use recorded RESOLVED status-change dates.',
        workload: 'Assigned workload includes all currently non-terminal incidents, regardless of report date.',
      },
    });
  } catch (error) {
    responseError(res, error, 'Authority analytics are temporarily unavailable');
  }
});

async function getTrend(
  granularity: 'week' | 'month',
  departmentId?: string,
  from?: string,
  to?: string,
) {
  const reportDepartmentClause = departmentId ? Prisma.sql`AND "departmentId" = ${departmentId}` : Prisma.empty;
  const resolutionDepartmentClause = departmentId ? Prisma.sql`AND i."departmentId" = ${departmentId}` : Prisma.empty;
  const reportFromClause = from ? Prisma.sql`AND "createdAt" >= ${new Date(`${from}T00:00:00.000Z`)}` : Prisma.empty;
  const resolutionFromClause = from ? Prisma.sql`AND a."createdAt" >= ${new Date(`${from}T00:00:00.000Z`)}` : Prisma.empty;
  const reportUntilClause = to ? (() => {
    const date = new Date(`${to}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return Prisma.sql`AND "createdAt" < ${date}`;
  })() : Prisma.empty;
  const resolutionUntilClause = to ? (() => {
    const date = new Date(`${to}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return Prisma.sql`AND a."createdAt" < ${date}`;
  })() : Prisma.empty;
  const [reports, resolutions] = await prisma.$transaction([
    prisma.$queryRaw<Array<{ period: Date; count: number }>>(Prisma.sql`
      SELECT date_trunc(${granularity}, "createdAt") AS period, COUNT(*)::int AS count
      FROM "Incident"
      WHERE TRUE ${reportDepartmentClause} ${reportFromClause} ${reportUntilClause}
      GROUP BY period
      ORDER BY period ASC
    `),
    prisma.$queryRaw<Array<{ period: Date; count: number }>>(Prisma.sql`
      SELECT date_trunc(${granularity}, a."createdAt") AS period, COUNT(*)::int AS count
      FROM "IncidentActivity" a
      JOIN "Incident" i ON i.id = a."incidentId"
      WHERE a."newStatus" = 'RESOLVED'
        ${resolutionDepartmentClause} ${resolutionFromClause} ${resolutionUntilClause}
      GROUP BY period
      ORDER BY period ASC
    `),
  ]);
  return mergeTrendRows(reports, resolutions);
}

const incidentSummarySelect = {
  id: true,
  departmentId: true,
  reporterId: true,
  status: true,
  assignedAuthorityId: true,
} satisfies Prisma.IncidentSelect;

const incidentDetailInclude = {
  department: { select: { id: true, name: true, code: true } },
  reporter: { select: { id: true, fullName: true } },
  assignedAuthority: { select: { id: true, fullName: true } },
  duplicateOf: { select: { id: true, title: true, status: true } },
  duplicates: { select: { id: true, title: true, status: true }, take: 10, orderBy: { createdAt: 'desc' } },
  evidence: {
    orderBy: { submittedAt: 'desc' },
    include: { submittedBy: { select: { id: true, fullName: true } } },
  },
  verificationCases: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: {
      resolutionEvidence: { select: { evidenceDescription: true, workCompleted: true, resolutionDate: true, evidenceImageUrls: true } },
      actions: { orderBy: { createdAt: 'asc' } },
      analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  },
  activities: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.IncidentInclude;

type IncidentSummary = Prisma.IncidentGetPayload<{ select: typeof incidentSummarySelect }>;
type IncidentDetails = Prisma.IncidentGetPayload<{ include: typeof incidentDetailInclude }>;
type AuthorizedLookup<T> = { ok: true; incident: T } | { ok: false; error: string };

function findAuthorizedIncident(role: UserRole, userId: string, incidentId: string, includeDetails: true): Promise<AuthorizedLookup<IncidentDetails>>;
function findAuthorizedIncident(role: UserRole, userId: string, incidentId: string, includeDetails?: false): Promise<AuthorizedLookup<IncidentSummary>>;
async function findAuthorizedIncident(
  role: UserRole,
  userId: string,
  incidentId: string,
  includeDetails = false,
): Promise<AuthorizedLookup<IncidentSummary | IncidentDetails>> {
  const scope = await departmentScope(role, userId);
  if (!scope.ok) return { ok: false, error: scope.error };
  const where: Prisma.IncidentWhereInput = {
    id: incidentId,
    ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
  };
  if (!includeDetails) {
    const incident = await prisma.incident.findFirst({ where, select: incidentSummarySelect });
    return incident ? { ok: true, incident } : { ok: false, error: 'Incident not found' };
  }
  const incident = await prisma.incident.findFirst({
    where,
    include: incidentDetailInclude,
  });
  return incident ? { ok: true, incident } : { ok: false, error: 'Incident not found' };
}

authorityRouter.get('/incidents/:id', async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  try {
    const result = await findAuthorizedIncident(req.user!.role, req.user!.id, id, true);
    if (!result.ok) return res.status(result.error.startsWith('An active') ? 403 : 404).json({ error: result.error });
    const { incident } = result;
    res.json({
      incident: {
        ...incident,
        allowedTransitions: validIncidentTransitions(incident.status).filter((status) => status !== 'VERIFICATION_PENDING' || incident.status === 'RESOLUTION_SUBMITTED'),
        reporter: incident.reporter,
      },
    });
  } catch (error) {
    responseError(res, error, 'Incident details are temporarily unavailable');
  }
});

authorityRouter.get('/incidents/:id/activity', async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  try {
    const result = await findAuthorizedIncident(req.user!.role, req.user!.id, id);
    if (!result.ok) return res.status(result.error.startsWith('An active') ? 403 : 404).json({ error: result.error });
    const activities = await prisma.incidentActivity.findMany({
      where: { incidentId: id },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, fullName: true } } },
    });
    res.json({ activities });
  } catch (error) {
    responseError(res, error, 'Incident activity is temporarily unavailable');
  }
});

async function eligibleAssignee(assignedAuthorityId: string, departmentId: string | null) {
  if (!departmentId) return null;
  return prisma.authorityProfile.findFirst({
    where: {
      userId: assignedAuthorityId,
      departmentId,
      department: { status: 'ACTIVE' },
      user: { role: 'AUTHORITY', accountStatus: 'ACTIVE' },
    },
    select: { userId: true, user: { select: { fullName: true } } },
  });
}

async function updateAssignment(req: Request, res: Response, targetId: string | null) {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  const found = await findAuthorizedIncident(req.user!.role, req.user!.id, id);
  if (!found.ok) return res.status(found.error.startsWith('An active') ? 403 : 404).json({ error: found.error });
  const { incident } = found;
  if (req.user!.role === 'AUTHORITY') {
    if (targetId !== null && targetId !== req.user!.id) return res.status(403).json({ error: 'Authorities may only assign incidents to themselves' });
    if (targetId === null && incident.assignedAuthorityId !== req.user!.id) return res.status(403).json({ error: 'You may only unassign incidents assigned to you' });
    if (targetId === req.user!.id && incident.assignedAuthorityId && incident.assignedAuthorityId !== req.user!.id) {
      return res.status(409).json({ error: 'This incident is already assigned to another authority' });
    }
  }
  const target = targetId ? await eligibleAssignee(targetId, incident.departmentId) : null;
  if (targetId && !target) return res.status(400).json({ error: 'The selected authority must be active and assigned to this incident department' });
  const previous = incident.assignedAuthorityId;
  if (previous === targetId) return res.json({ assignedAuthorityId: previous, message: 'Assignment is unchanged' });

  await prisma.$transaction(async (tx) => {
    await tx.incident.update({
      where: { id },
      data: { assignedAuthorityId: targetId, assignedAt: targetId ? new Date() : null },
    });
    await tx.incidentActivity.create({
      data: {
        incidentId: id,
        actorUserId: req.user!.id,
        activityType: targetId ? 'AUTHORITY_ASSIGNED' : 'AUTHORITY_UNASSIGNED',
        activityDescription: targetId && target
          ? `${target.user.fullName} was assigned to this incident.`
          : 'The incident was unassigned.',
        visibility: 'PUBLIC',
        metadata: { previousAuthorityId: previous, assignedAuthorityId: targetId },
      },
    });
  });
  res.json({ assignedAuthorityId: targetId, assignedAuthority: target ? { id: target.userId, fullName: target.user.fullName } : null });
}

authorityRouter.post('/incidents/:id/assign', writeLimiter, async (req, res) => {
  const parsed = assignSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid assignment details', fields: parsed.error.flatten().fieldErrors });
  if (req.user!.role === 'ADMIN' && !parsed.data.assignedAuthorityId) {
    return res.status(400).json({ error: 'Administrators must select an eligible authority to assign' });
  }
  if (req.user!.role === 'AUTHORITY' && parsed.data.assignedAuthorityId && parsed.data.assignedAuthorityId !== req.user!.id) {
    return res.status(403).json({ error: 'Authorities may only assign incidents to themselves' });
  }
  try {
    return await updateAssignment(req, res, req.user!.role === 'AUTHORITY' ? req.user!.id : parsed.data.assignedAuthorityId!);
  } catch (error) {
    responseError(res, error, 'Unable to update incident assignment');
  }
});

authorityRouter.patch('/incidents/:id/assignment', writeLimiter, async (req, res) => {
  const parsed = assignmentPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid assignment details', fields: parsed.error.flatten().fieldErrors });
  try {
    return await updateAssignment(req, res, parsed.data.assignedAuthorityId);
  } catch (error) {
    responseError(res, error, 'Unable to update incident assignment');
  }
});

authorityRouter.patch('/incidents/:id/status', writeLimiter, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status change', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  try {
    const found = await findAuthorizedIncident(req.user!.role, req.user!.id, id);
    if (!found.ok) return res.status(found.error.startsWith('An active') ? 403 : 404).json({ error: found.error });
    if (parsed.data.status === 'VERIFICATION_PENDING' && found.incident.status !== 'RESOLUTION_SUBMITTED') {
      return res.status(409).json({ error: 'Use the resolution submission workflow to send an in-progress incident for verification' });
    }
    await prisma.$transaction((tx) => transitionIncident(tx, {
      incidentId: id,
      actorUserId: req.user!.id,
      target: parsed.data.status,
      reason: parsed.data.reason,
      duplicateOfIncidentId: parsed.data.relatedIncidentId,
    }));
    res.json({ success: true, status: parsed.data.status });
  } catch (error) {
    if (error instanceof InvalidIncidentTransitionError) return res.status(409).json({ error: error.message });
    responseError(res, error, 'Unable to change incident status');
  }
});

authorityRouter.post('/incidents/:id/updates', writeLimiter, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid operational update', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  try {
    const found = await findAuthorizedIncident(req.user!.role, req.user!.id, id);
    if (!found.ok) return res.status(found.error.startsWith('An active') ? 403 : 404).json({ error: found.error });
    const activity = await prisma.incidentActivity.create({
      data: {
        incidentId: id,
        actorUserId: req.user!.id,
        activityType: parsed.data.visibility === 'INTERNAL' ? 'INTERNAL_NOTE' : 'OPERATIONAL_UPDATE',
        activityDescription: parsed.data.text,
        visibility: parsed.data.visibility,
      },
      include: { actor: { select: { id: true, fullName: true } } },
    });
    res.status(201).json({ activity });
  } catch (error) {
    responseError(res, error, 'Unable to save the operational update');
  }
});

authorityRouter.post('/incidents/:id/resolution', writeLimiter, async (req, res) => {
  const parsed = resolutionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid resolution submission', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Incident not found' });
  try {
    const found = await findAuthorizedIncident(req.user!.role, req.user!.id, id);
    if (!found.ok) return res.status(found.error.startsWith('An active') ? 403 : 404).json({ error: found.error });
    if (found.incident.status !== 'IN_PROGRESS') return res.status(409).json({ error: 'Move the incident to In Progress before submitting a resolution' });
    const names = parsed.data.imageUrls.map((url) => url.slice('/api/uploads/'.length));
    const uploads = names.length ? await prisma.incidentUpload.findMany({
      where: { storedName: { in: names }, uploadedByUserId: req.user!.id, incidentId: null },
      select: { storedName: true },
    }) : [];
    if (uploads.length !== names.length) return res.status(400).json({ error: 'One or more evidence images are invalid or not owned by the submitting authority' });
    const resolutionDate = parsed.data.resolutionDate
      ? new Date(`${parsed.data.resolutionDate}T00:00:00.000Z`)
      : new Date();
    const responseDeadline = new Date(Date.now() + verificationResponseHours * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const attached = names.length ? await tx.incidentUpload.updateMany({
        where: { storedName: { in: names }, uploadedByUserId: req.user!.id, incidentId: null },
        data: { incidentId: id, isPublic: true },
      }) : { count: 0 };
      if (attached.count !== names.length) throw new Error('Evidence upload ownership changed during resolution submission');
      const evidence = await tx.resolutionEvidence.create({
        data: {
          incidentId: id,
          submittedByUserId: req.user!.id,
          evidenceImageUrls: parsed.data.imageUrls,
          evidenceDescription: parsed.data.description,
          workCompleted: parsed.data.workCompleted,
          resolutionDate,
          internalNotes: parsed.data.notes || null,
          verificationResult: 'PENDING',
        },
      });
      await tx.verificationCase.create({
        data: {
          incidentId: id,
          resolutionEvidenceId: evidence.id,
          reporterId: found.incident.reporterId,
          responseDeadline,
        },
      });
      await tx.incident.update({ where: { id }, data: { resolutionDescription: parsed.data.description } });
      await transitionIncident(tx, {
        incidentId: id,
        actorUserId: req.user!.id,
        target: 'RESOLUTION_SUBMITTED',
        activityType: 'RESOLUTION_SUBMITTED',
        activityDescription: 'Resolution evidence submitted for verification.',
        metadata: { evidenceCount: names.length, resolutionDate: resolutionDate.toISOString() },
      });
      await transitionIncident(tx, {
        incidentId: id,
        actorUserId: req.user!.id,
        target: 'VERIFICATION_PENDING',
        activityType: 'VERIFICATION_REQUESTED',
        activityDescription: 'Citizen verification was requested for the submitted resolution.',
        metadata: { responseDeadline: responseDeadline.toISOString() },
      });
      if (names.length) await tx.incidentActivity.create({
        data: {
          incidentId: id,
          actorUserId: req.user!.id,
          activityType: 'EVIDENCE_SUBMITTED',
          activityDescription: `${names.length} resolution evidence image${names.length === 1 ? '' : 's'} submitted.`,
          visibility: 'PUBLIC',
          metadata: { evidenceCount: names.length },
        },
      });
      if (parsed.data.notes) await tx.incidentActivity.create({
        data: {
          incidentId: id,
          actorUserId: req.user!.id,
          activityType: 'INTERNAL_NOTE',
          activityDescription: parsed.data.notes,
          visibility: 'INTERNAL',
        },
      });
      return evidence;
    });
    res.status(201).json({ evidence: result, status: 'VERIFICATION_PENDING' });
  } catch (error) {
    if (error instanceof Error && error.message === 'Evidence upload ownership changed during resolution submission') {
      return res.status(409).json({ error: 'Evidence was already attached to another record. Upload it again before submitting.' });
    }
    responseError(res, error, 'Unable to submit the resolution');
  }
});

authorityRouter.get('/authorities', async (req, res) => {
  try {
    const scope = await departmentScope(req.user!.role, req.user!.id, queryValue(req, 'departmentId'));
    if (!scope.ok) return res.status(403).json({ error: scope.error });
    const authorities = await prisma.authorityProfile.findMany({
      where: scope.departmentId ? { departmentId: scope.departmentId } : undefined,
      select: {
        userId: true,
        designation: true,
        departmentId: true,
        user: { select: { fullName: true, accountStatus: true, role: true } },
      },
      orderBy: { user: { fullName: 'asc' } },
    });
    res.json({
      authorities: authorities.filter((item) => item.user.role === 'AUTHORITY').map((item) => ({
        id: item.userId,
        fullName: item.user.fullName,
        designation: item.designation,
        departmentId: item.departmentId,
        active: item.user.accountStatus === 'ACTIVE',
      })),
    });
  } catch (error) {
    responseError(res, error, 'Unable to load eligible authorities');
  }
});

export { actionableStatuses, overdueHours, unacknowledgedHours };
