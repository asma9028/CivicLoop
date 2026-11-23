import {
  CampaignAuditAction,
  CivicCampaignStatus,
  IncidentStatus,
  Prisma,
  type CivicCampaignType,
  type IncidentCategory,
  type PriorityBand,
  type Severity,
  type UserRole,
} from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js';
import {
  CampaignChangedError,
  campaignSnapshotWhere,
  getCampaignAuditAction,
  isCampaignJoinable,
  isValidCampaignTransition,
} from '../services/community/campaigns.js';
import { areaBounds, distanceMeters } from '../services/community/geo.js';
import { calculateCollectiveSignal } from '../services/community/signals.js';
import { roundPublicCoordinate, sanitizePublicText, serializePublicIncident } from '../utils/public-incident.js';
import { logSafeError } from '../utils/safe-logger.js';

export const communityRouter = Router();

const categories: IncidentCategory[] = ['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER'];
const priorities: PriorityBand[] = ['P1', 'P2', 'P3', 'P4'];
const statuses = Object.values(IncidentStatus);
const campaignTypes: CivicCampaignType[] = ['AWARENESS', 'CLEANUP', 'INFRASTRUCTURE', 'SAFETY', 'CONSERVATION', 'OTHER'];
const supportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const areaLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const campaignLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });
const notificationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const dateOnly = z.string().date();
const coordinate = z.number().finite();

const feedQuerySchema = pageSchema.extend({
  search: z.string().trim().max(120).optional(),
  category: z.enum(categories as [IncidentCategory, ...IncidentCategory[]]).optional(),
  status: z.enum(statuses as [IncidentStatus, ...IncidentStatus[]]).optional(),
  priority: z.enum(priorities as [PriorityBand, ...PriorityBand[]]).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  location: z.string().trim().max(120).optional(),
  sort: z.enum(['recent', 'supported', 'priority']).default('recent'),
}).strict().superRefine((query, context) => {
  if (query.search && sanitizePublicText(query.search, 120) !== query.search) {
    context.addIssue({
      code: 'custom',
      path: ['search'],
      message: 'Search cannot include an address or sensitive identifier',
    });
  }
  if (query.location) {
    context.addIssue({
      code: 'custom',
      path: ['location'],
      message: 'Filtering by stored address text is unavailable for privacy',
    });
  }
});

const areaSchema = z.object({
  name: z.string().trim().min(2).max(60),
  centerLatitude: coordinate.min(-90).max(90),
  centerLongitude: coordinate.min(-180).max(180),
  radiusMeters: z.number().int().min(100).max(10_000).default(500),
}).strict();

const campaignFields = {
  name: z.string().trim().min(5).max(120),
  description: z.string().trim().min(20).max(2_000),
  campaignType: z.enum(campaignTypes as [CivicCampaignType, ...CivicCampaignType[]]),
  objective: z.string().trim().min(10).max(1_000),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  targetAreaLabel: z.string().trim().min(2).max(120),
  targetLatitude: coordinate.min(-90).max(90).nullable().optional(),
  targetLongitude: coordinate.min(-180).max(180).nullable().optional(),
  radiusMeters: z.number().int().min(100).max(50_000).nullable().optional(),
  departmentId: z.string().min(1).max(64).nullable().optional(),
};

const campaignBaseSchema = z.object(campaignFields).strict();
const campaignCreateSchema = campaignBaseSchema.superRefine(validateCampaignBody);
const campaignUpdateSchema = campaignBaseSchema.partial().extend({
  status: z.nativeEnum(CivicCampaignStatus).optional(),
}).strict().superRefine((value, context) => {
  validateCampaignBody(value, context);
  const hasLocationField = value.targetLatitude !== undefined
    || value.targetLongitude !== undefined
    || value.radiusMeters !== undefined;
  if (hasLocationField
    && (value.targetLatitude === undefined || value.targetLongitude === undefined || value.radiusMeters === undefined)) {
    context.addIssue({ code: 'custom', path: ['targetLatitude'], message: 'Target latitude, longitude, and radius must be updated together' });
  }
}).refine(
  (value) => Object.keys(value).length > 0,
  'At least one campaign field must be provided',
);

const campaignListSchema = pageSchema.extend({
  search: z.string().trim().max(120).optional(),
  campaignType: z.enum(campaignTypes as [CivicCampaignType, ...CivicCampaignType[]]).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  status: z.nativeEnum(CivicCampaignStatus).optional(),
  joined: z.enum(['true', 'false']).optional(),
}).strict();

const impactQuerySchema = pageSchema.extend({
  category: z.enum(categories as [IncidentCategory, ...IncidentCategory[]]).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  centerLatitude: z.coerce.number().finite().min(-90).max(90).optional(),
  centerLongitude: z.coerce.number().finite().min(-180).max(180).optional(),
  radiusMeters: z.coerce.number().int().min(100).max(50_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'The end date must be on or after the start date' });
  }
  if ((value.centerLatitude === undefined) !== (value.centerLongitude === undefined)) {
    context.addIssue({ code: 'custom', path: ['centerLatitude'], message: 'Both center coordinates are required for an area filter' });
  }
  if (value.centerLatitude !== undefined && value.radiusMeters === undefined) {
    context.addIssue({ code: 'custom', path: ['radiusMeters'], message: 'An area radius is required with center coordinates' });
  }
  if (value.centerLatitude === undefined && value.radiusMeters !== undefined) {
    context.addIssue({ code: 'custom', path: ['radiusMeters'], message: 'A radius requires center coordinates' });
  }
});

function validateCampaignBody(value: {
  startAt?: string;
  endAt?: string;
  targetLatitude?: number | null;
  targetLongitude?: number | null;
  radiusMeters?: number | null;
}, context: z.RefinementCtx) {
  if (value.startAt && value.endAt && value.startAt >= value.endAt) {
    context.addIssue({ code: 'custom', path: ['endAt'], message: 'Campaign end must be after its start' });
  }
  const coordinatesProvided = value.targetLatitude != null || value.targetLongitude != null || value.radiusMeters != null;
  const completeCoordinates = value.targetLatitude != null && value.targetLongitude != null && value.radiusMeters != null;
  if (coordinatesProvided && !completeCoordinates) {
    context.addIssue({ code: 'custom', path: ['targetLatitude'], message: 'Target latitude, longitude, and radius must be provided together' });
  }
}

const communityIncidentSelect = {
  id: true,
  title: true,
  category: true,
  severity: true,
  status: true,
  priorityBand: true,
  priorityScore: true,
  latitude: true,
  longitude: true,
  locationText: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  department: { select: { id: true, name: true } },
  duplicateOf: { select: { id: true, title: true, status: true, isPublic: true } },
  duplicates: {
    where: { isPublic: true },
    take: 8,
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, status: true },
  },
  activities: {
    where: { visibility: 'PUBLIC' },
    take: 20,
    orderBy: { createdAt: 'desc' },
    select: { id: true, activityType: true, activityDescription: true, newStatus: true, createdAt: true },
  },
  verificationCases: {
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      createdAt: true,
      resolutionEvidence: {
        select: {
          evidenceDescription: true,
          resolutionDate: true,
          verifiedAt: true,
          evidenceImageUrls: true,
        },
      },
    },
  },
  uploads: { where: { isPublic: true }, select: { storedName: true } },
  _count: {
    select: {
      supporters: { where: { isActive: true } },
      activities: { where: { newStatus: 'REOPENED', visibility: 'PUBLIC' } },
    },
  },
} satisfies Prisma.IncidentSelect;

type CommunityIncidentRecord = Prisma.IncidentGetPayload<{ select: typeof communityIncidentSelect }>;

const campaignInclude = {
  department: { select: { id: true, name: true } },
  creator: { select: { role: true } },
  _count: {
    select: {
      participants: { where: { isActive: true } },
      incidentLinks: { where: { incident: { isPublic: true } } },
    },
  },
} satisfies Prisma.CivicCampaignInclude;

function getId(req: Request, key = 'id') {
  const id = req.params[key];
  return typeof id === 'string' ? id : null;
}

function progressFor(status: IncidentStatus) {
  const progress: Record<IncidentStatus, number> = {
    REPORTED: 15,
    ACKNOWLEDGED: 35,
    IN_PROGRESS: 60,
    RESOLUTION_SUBMITTED: 75,
    VERIFICATION_PENDING: 85,
    RESOLVED: 100,
    REOPENED: 60,
    ON_HOLD: 45,
    REJECTED: 0,
    DUPLICATE: 0,
  };
  return progress[status];
}

function publicIncident(record: CommunityIncidentRecord, isSupported = false) {
  const latestCase = record.verificationCases[0];
  const verified = record.status === 'RESOLVED' && latestCase?.status === 'VERIFIED';
  const publicUploads = new Set(record.uploads.map((upload) => upload.storedName));
  const latestUpdate = record.activities[0];
  const publicFields = serializePublicIncident({
    title: record.title,
    description: '',
    category: record.category,
    latitude: record.latitude,
    longitude: record.longitude,
  });
  return {
    id: record.id,
    title: publicFields.title,
    category: record.category,
    status: record.status,
    priorityBand: record.priorityBand,
    reportedAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: verified ? record.resolvedAt : null,
    department: record.department?.name ?? 'Unassigned',
    location: {
      label: 'Approximate area (about 1 km precision)',
      latitude: publicFields.latitude,
      longitude: publicFields.longitude,
    },
    supportCount: record._count.supporters,
    isSupported,
    progressPercent: progressFor(record.status),
    verificationStatus: verified ? 'VERIFIED' : latestCase?.status ?? 'NOT_SUBMITTED',
    isReopened: record.status === 'REOPENED' || record._count.activities > 0,
    latestPublicUpdate: latestUpdate
      ? {
          type: latestUpdate.activityType,
          message: sanitizePublicText(latestUpdate.activityDescription),
          createdAt: latestUpdate.createdAt,
        }
      : null,
  };
}

function publicIncidentDetail(record: CommunityIncidentRecord, isSupported: boolean, signal: ReturnType<typeof calculateCollectiveSignal>, signalTrend: Array<{ day: string; supports: number }>) {
  const current = publicIncident(record, isSupported);
  const latestCase = record.verificationCases[0];
  const verified = current.verificationStatus === 'VERIFIED' && latestCase;
  const publicUploads = new Set(record.uploads.map((upload) => upload.storedName));
  return {
    ...current,
    overview: `${record.category.replaceAll('_', ' ').toLowerCase()} issue submitted in this approximate area.`,
    signal,
    signalMethod: {
      supportWeightPercent: 40,
      recurrenceWeightPercent: 20,
      severityWeightPercent: 15,
      timeOpenWeightPercent: 10,
      reopenWeightPercent: 10,
      disputeWeightPercent: 5,
      note: 'This community signal is separate from the incident priority and does not change it. Support is one signal among recurrence, severity, time, reopen, and dispute history.',
    },
    signalTrend,
    timeline: record.activities
      .slice()
      .reverse()
      .map((activity) => ({
        id: activity.id,
        type: activity.activityType,
        status: activity.newStatus,
        message: sanitizePublicText(activity.activityDescription),
        createdAt: activity.createdAt,
      })),
    verification: {
      status: verified ? 'VERIFIED' : latestCase?.status ?? 'NOT_SUBMITTED',
      isReopened: current.isReopened,
      ...(verified ? {
        verifiedAt: latestCase.createdAt,
        resolutionSummary: `${record.category.replaceAll('_', ' ').toLowerCase()} issue independently verified as resolved.`,
        resolutionDate: latestCase.resolutionEvidence.resolutionDate,
        evidenceImageUrls: latestCase.resolutionEvidence.evidenceImageUrls.filter((url) =>
          publicUploads.has(url.slice('/api/uploads/'.length)),
        ),
      } : {}),
    },
    relatedIncidents: [
      ...(record.duplicateOf?.isPublic ? [record.duplicateOf] : []),
      ...record.duplicates,
    ].map(({ id, title, status }) => ({ id, title: sanitizePublicText(title, 160), status })),
  };
}

function areaIncidentWhere(area: { centerLatitude: number; centerLongitude: number; radiusMeters: number }): Prisma.IncidentWhereInput {
  const bounds = areaBounds(area.centerLatitude, area.centerLongitude, area.radiusMeters);
  return {
    AND: [
      { latitude: { gte: bounds.minLatitude, lte: bounds.maxLatitude } },
      { OR: bounds.longitudeRanges.map((range) => ({ longitude: { gte: range.min, lte: range.max } })) },
    ],
  };
}

function areasIncidentWhere(areas: Array<{
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
  followedAt: Date;
}>): Prisma.IncidentWhereInput {
  return {
    AND: [{
      OR: areas.flatMap((area) => {
        const bounds = areaBounds(area.centerLatitude, area.centerLongitude, area.radiusMeters);
        return bounds.longitudeRanges.map((range) => ({
          AND: [
            { latitude: { gte: bounds.minLatitude, lte: bounds.maxLatitude } },
            { longitude: { gte: range.min, lte: range.max } },
            { createdAt: { gte: area.followedAt } },
          ],
        }));
      }),
    }],
  };
}

async function loadAreaIncidents(area: {
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
}) {
  const candidates = await prisma.incident.findMany({
    where: { isPublic: true, ...areaIncidentWhere(area) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: communityIncidentSelect,
  });
  return candidates.filter((incident) =>
    distanceMeters(
      { latitude: area.centerLatitude, longitude: area.centerLongitude },
      { latitude: incident.latitude, longitude: incident.longitude },
    ) <= area.radiusMeters,
  );
}

function failure(res: Response, error: unknown, message: string, status = 503) {
  logSafeError('community.request', error, res.getHeader('X-Request-Id'));
  return res.status(status).json({ error: message });
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function feedWhere(query: z.infer<typeof feedQuerySchema>): Prisma.IncidentWhereInput {
  const clauses: Prisma.IncidentWhereInput[] = [{ isPublic: true }];
  if (query.category) clauses.push({ category: query.category });
  if (query.status) clauses.push({ status: query.status });
  if (query.priority) clauses.push({ priorityBand: query.priority });
  if (query.departmentId) clauses.push({ departmentId: query.departmentId });
  if (query.search) clauses.push({ OR: [{ title: { contains: query.search, mode: 'insensitive' } }] });
  return { AND: clauses };
}

function feedSqlWhere(query: z.infer<typeof feedQuerySchema>) {
  const clauses: Prisma.Sql[] = [Prisma.sql`i."isPublic" = TRUE`];
  if (query.category) clauses.push(Prisma.sql`i.category = CAST(${query.category} AS "IncidentCategory")`);
  if (query.status) clauses.push(Prisma.sql`i.status = CAST(${query.status} AS "IncidentStatus")`);
  if (query.priority) clauses.push(Prisma.sql`i."priorityBand" = CAST(${query.priority} AS "PriorityBand")`);
  if (query.departmentId) clauses.push(Prisma.sql`i."departmentId" = ${query.departmentId}`);
  if (query.search) clauses.push(Prisma.sql`i.title ILIKE ${`%${query.search}%`}`);
  return Prisma.join(clauses, ' AND ');
}

communityRouter.get('/incidents', optionalAuth, async (req, res) => {
  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid community filters', fields: parsed.error.flatten().fieldErrors });
  const { page, limit } = parsed.data;
  try {
    const where = feedWhere(parsed.data);
    let total = await prisma.incident.count({ where });
    let rows: CommunityIncidentRecord[];
    if (parsed.data.sort === 'supported') {
      const filterSql = feedSqlWhere(parsed.data);
      const [ranked, count] = await Promise.all([
        prisma.$queryRaw<Array<{ incidentId: string; supportCount: number }>>(Prisma.sql`
          SELECT i.id AS "incidentId", COUNT(*)::int AS "supportCount"
          FROM "IncidentSupport" s
          JOIN "Incident" i ON i.id = s."incidentId"
          WHERE s."isActive" = TRUE AND ${filterSql}
          GROUP BY i.id
          ORDER BY "supportCount" DESC, i.id ASC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        `),
        prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT COUNT(DISTINCT i.id)::int AS total
          FROM "IncidentSupport" s
          JOIN "Incident" i ON i.id = s."incidentId"
          WHERE s."isActive" = TRUE AND ${filterSql}
        `),
      ]);
      const rankedIds = ranked.map((item) => item.incidentId);
      total = count[0]?.total ?? 0;
      const pageRows = rankedIds.length ? await prisma.incident.findMany({
        where: { id: { in: rankedIds }, isPublic: true },
        select: communityIncidentSelect,
      }) : [];
      const byId = new Map(pageRows.map((item) => [item.id, item]));
      rows = rankedIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
    } else {
      rows = await prisma.incident.findMany({
        where,
        orderBy: parsed.data.sort === 'priority'
          ? [{ priorityScore: 'desc' }, { createdAt: 'desc' }]
          : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: communityIncidentSelect,
      });
    }
    const supportStates = req.user?.role === 'CITIZEN' && rows.length
      ? await prisma.incidentSupport.findMany({
          where: { incidentId: { in: rows.map((row) => row.id) }, userId: req.user.id, isActive: true },
          select: { incidentId: true },
        })
      : [];
    const supportedIds = new Set(supportStates.map((item) => item.incidentId));
    return res.json({
      incidents: rows.map((row) => publicIncident(row, supportedIds.has(row.id))),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      filters: { sort: parsed.data.sort },
    });
  } catch (error) {
    return failure(res, error, 'The community feed is temporarily unavailable');
  }
});

communityRouter.get('/incidents/:id', optionalAuth, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Community issue not found' });
  try {
    const record = await prisma.incident.findFirst({
      where: { id, isPublic: true },
      select: communityIncidentSelect,
    });
    if (!record) return res.status(404).json({ error: 'Community issue not found' });
    const [supportState, recurrenceCandidates, supportTrend] = await Promise.all([
      req.user?.role === 'CITIZEN'
        ? prisma.incidentSupport.findUnique({ where: { incidentId_userId: { incidentId: id, userId: req.user.id } }, select: { isActive: true } })
        : Promise.resolve(null),
      prisma.incident.findMany({
        where: {
          isPublic: true,
          id: { not: id },
          category: record.category,
          duplicateOfIncidentId: null,
          createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) },
          ...areaIncidentWhere({ centerLatitude: record.latitude, centerLongitude: record.longitude, radiusMeters: 250 }),
        },
        select: { latitude: true, longitude: true },
        take: 500,
      }),
      prisma.$queryRaw<Array<{ day: Date; supports: number }>>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS supports
        FROM "IncidentSupportEvent"
        WHERE "incidentId" = ${id}
          AND action = 'SUPPORTED'::"SupportEventAction"
          AND "createdAt" >= ${new Date(Date.now() - 30 * 86_400_000)}
        GROUP BY day
        ORDER BY day ASC
      `),
    ]);
    const recurrenceCount = recurrenceCandidates.filter((candidate) =>
      distanceMeters(record, candidate) <= 250,
    ).length;
    const signal = calculateCollectiveSignal({
      supportCount: record._count.supporters,
      recurrenceCount,
      severity: record.severity as Severity,
      ageDays: (Date.now() - record.createdAt.getTime()) / 86_400_000,
      reopenCount: record._count.activities,
      disputedResolutionCount: record.verificationCases.filter((item) => ['DISPUTED', 'REVIEW_REQUIRED'].includes(item.status)).length,
    });
    return res.json({
      incident: publicIncidentDetail(
        record,
        supportState?.isActive ?? false,
        signal,
        supportTrend.map((item) => ({ day: item.day.toISOString().slice(0, 10), supports: item.supports })),
      ),
      recurrence: { nearbyIndependentReports: recurrenceCount, radiusMeters: 250, windowDays: 365 },
    });
  } catch (error) {
    return failure(res, error, 'Community issue details are temporarily unavailable');
  }
});

communityRouter.put('/incidents/:id/support', requireAuth, requireRole('CITIZEN'), supportLimiter, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Community issue not found' });
  try {
    const incident = await prisma.incident.findFirst({ where: { id, isPublic: true }, select: { id: true } });
    if (!incident) return res.status(404).json({ error: 'Community issue not found' });
    const now = new Date();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const previous = await tx.incidentSupport.findUnique({
          where: { incidentId_userId: { incidentId: id, userId: req.user!.id } },
        });
        if (previous?.isActive) return { changed: false };
        if (previous) {
          await tx.incidentSupport.update({
            where: { id: previous.id },
            data: { isActive: true, supportedAt: now, withdrawnAt: null },
          });
        } else {
          await tx.incidentSupport.create({
            data: { incidentId: id, userId: req.user!.id, isActive: true, supportedAt: now },
          });
        }
        await tx.incidentSupportEvent.create({
          data: { incidentId: id, userId: req.user!.id, action: 'SUPPORTED', createdAt: now },
        });
        return { changed: true };
      });
      const supportCount = await prisma.incidentSupport.count({ where: { incidentId: id, isActive: true } });
      return res.json({ supported: true, supportCount, changed: result.changed });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const supportCount = await prisma.incidentSupport.count({ where: { incidentId: id, isActive: true } });
      return res.json({ supported: true, supportCount, changed: false });
    }
  } catch (error) {
    return failure(res, error, 'Unable to record community support');
  }
});

communityRouter.delete('/incidents/:id/support', requireAuth, requireRole('CITIZEN'), supportLimiter, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Community issue not found' });
  try {
    const incident = await prisma.incident.findFirst({ where: { id, isPublic: true }, select: { id: true } });
    if (!incident) return res.status(404).json({ error: 'Community issue not found' });
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const previous = await tx.incidentSupport.findUnique({
        where: { incidentId_userId: { incidentId: id, userId: req.user!.id } },
      });
      if (!previous?.isActive) return { changed: false };
      await tx.incidentSupport.update({
        where: { id: previous.id },
        data: { isActive: false, withdrawnAt: now },
      });
      await tx.incidentSupportEvent.create({
        data: { incidentId: id, userId: req.user!.id, action: 'UNSUPPORTED', createdAt: now },
      });
      return { changed: true };
    });
    const supportCount = await prisma.incidentSupport.count({ where: { incidentId: id, isActive: true } });
    return res.json({ supported: false, supportCount, changed: result.changed });
  } catch (error) {
    return failure(res, error, 'Unable to remove community support');
  }
});

communityRouter.get('/areas', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  try {
    const areas = await prisma.followedArea.findMany({
      where: { userId: req.user!.id, isActive: true },
      orderBy: { followedAt: 'desc' },
      select: { id: true, name: true, centerLatitude: true, centerLongitude: true, radiusMeters: true, followedAt: true },
    });
    return res.json({ areas });
  } catch (error) {
    return failure(res, error, 'Followed areas are temporarily unavailable');
  }
});

communityRouter.post('/areas', requireAuth, requireRole('CITIZEN'), areaLimiter, async (req, res) => {
  const parsed = areaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid followed area', fields: parsed.error.flatten().fieldErrors });
  try {
    const activeCount = await prisma.followedArea.count({ where: { userId: req.user!.id, isActive: true } });
    const existing = await prisma.followedArea.findFirst({
      where: { userId: req.user!.id, name: { equals: parsed.data.name, mode: 'insensitive' } },
    });
    if (activeCount >= 20 && !existing?.isActive) return res.status(409).json({ error: 'You can follow up to 20 areas' });
    const now = new Date();
    const area = existing
      ? await prisma.followedArea.update({
          where: { id: existing.id },
          data: {
            name: parsed.data.name,
            centerLatitude: parsed.data.centerLatitude,
            centerLongitude: parsed.data.centerLongitude,
            radiusMeters: parsed.data.radiusMeters,
            isActive: true,
            followedAt: now,
            unfollowedAt: null,
          },
        })
      : await prisma.followedArea.create({
          data: { ...parsed.data, userId: req.user!.id, followedAt: now },
        });
    return res.status(existing ? 200 : 201).json({
      area: {
        id: area.id, name: area.name, centerLatitude: area.centerLatitude,
        centerLongitude: area.centerLongitude, radiusMeters: area.radiusMeters, followedAt: area.followedAt,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: 'You already follow an area with that name' });
    return failure(res, error, 'Unable to follow this area');
  }
});

communityRouter.delete('/areas/:id', requireAuth, requireRole('CITIZEN'), areaLimiter, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Followed area not found' });
  try {
    const area = await prisma.followedArea.findFirst({ where: { id, userId: req.user!.id, isActive: true }, select: { id: true } });
    if (!area) return res.status(404).json({ error: 'Followed area not found' });
    await prisma.followedArea.update({ where: { id }, data: { isActive: false, unfollowedAt: new Date() } });
    return res.json({ followed: false });
  } catch (error) {
    return failure(res, error, 'Unable to unfollow this area');
  }
});

communityRouter.get('/areas/:id/activity', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Followed area not found' });
  try {
    const area = await prisma.followedArea.findFirst({
      where: { id, userId: req.user!.id, isActive: true },
      select: { id: true, name: true, centerLatitude: true, centerLongitude: true, radiusMeters: true },
    });
    if (!area) return res.status(404).json({ error: 'Followed area not found' });
    const [incidents, campaigns] = await Promise.all([
      loadAreaIncidents(area),
      prisma.civicCampaign.findMany({
        where: { status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] }, targetLatitude: { not: null }, targetLongitude: { not: null } },
        include: campaignInclude,
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    ]);
    const nearbyCampaigns = campaigns.filter((campaign) =>
      campaign.targetLatitude !== null
      && campaign.targetLongitude !== null
      && distanceMeters(
        { latitude: area.centerLatitude, longitude: area.centerLongitude },
        { latitude: campaign.targetLatitude, longitude: campaign.targetLongitude },
      )
        <= area.radiusMeters + (campaign.radiusMeters ?? 0),
    );
    return res.json({
      area: { id: area.id, name: area.name, radiusMeters: area.radiusMeters },
      incidents: incidents.map((incident) => publicIncident(incident)),
      campaigns: nearbyCampaigns.map((campaign) => serializeCampaign(campaign)),
    });
  } catch (error) {
    return failure(res, error, 'Area activity is temporarily unavailable');
  }
});

function impactPeriod(query: z.infer<typeof impactQuerySchema>) {
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : new Date();
  const from = query.from
    ? new Date(`${query.from}T00:00:00.000Z`)
    : new Date(to.getTime() - 365 * 86_400_000);
  return { from, to };
}

function impactBaseWhere(
  query: z.infer<typeof impactQuerySchema>,
  period: { from: Date; to: Date },
): Prisma.IncidentWhereInput {
  return {
    isPublic: true,
    status: 'RESOLVED',
    resolvedAt: { gte: period.from, lte: period.to },
    verificationCases: { some: { status: 'VERIFIED' } },
    ...(query.category ? { category: query.category } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
  };
}

const impactIncidentSelect = {
  id: true,
  category: true,
  latitude: true,
  longitude: true,
  createdAt: true,
  resolvedAt: true,
  department: { select: { id: true, name: true } },
  uploads: { where: { isPublic: true }, select: { storedName: true } },
  verificationCases: {
    where: { status: 'VERIFIED' },
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      resolutionEvidence: {
        select: {
          evidenceDescription: true,
          evidenceImageUrls: true,
          verifiedAt: true,
        },
      },
      actions: {
        where: { actionType: { in: ['CITIZEN_CONFIRMED', 'REVIEW_CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  },
} satisfies Prisma.IncidentSelect;

type ImpactRecord = Prisma.IncidentGetPayload<{ select: typeof impactIncidentSelect }>;

function serializeImpactRecord(record: ImpactRecord) {
  const verificationCase = record.verificationCases[0];
  const uploads = new Set(record.uploads.map((upload) => upload.storedName));
  return {
    incidentId: record.id,
    category: record.category,
    location: {
      label: 'Approximate area (about 1 km precision)',
      latitude: roundPublicCoordinate(record.latitude),
      longitude: roundPublicCoordinate(record.longitude),
    },
    reportedAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    verifiedAt: verificationCase?.actions[0]?.createdAt
      ?? verificationCase?.resolutionEvidence.verifiedAt
      ?? null,
    department: record.department?.name ?? 'Unassigned',
    resolutionSummary: `${record.category.replaceAll('_', ' ').toLowerCase()} issue independently verified as resolved.`,
    verificationOutcome: 'VERIFIED',
    publicEvidence: verificationCase?.resolutionEvidence.evidenceImageUrls.filter((url) =>
      uploads.has(url.slice('/api/uploads/'.length)),
    ) ?? [],
  };
}

function impactSqlWhere(query: z.infer<typeof impactQuerySchema>, period: { from: Date; to: Date }, ids?: string[]) {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`"isPublic" = TRUE`,
    Prisma.sql`status = 'RESOLVED'::"IncidentStatus"`,
    Prisma.sql`"resolvedAt" IS NOT NULL`,
    Prisma.sql`"resolvedAt" >= ${period.from}`,
    Prisma.sql`"resolvedAt" <= ${period.to}`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM "VerificationCase" vc
      WHERE vc."incidentId" = "Incident"."id"
        AND vc.status = 'VERIFIED'::"VerificationCaseStatus"
    )`,
  ];
  if (query.category) clauses.push(Prisma.sql`category = CAST(${query.category} AS "IncidentCategory")`);
  if (query.departmentId) clauses.push(Prisma.sql`"departmentId" = ${query.departmentId}`);
  if (ids) clauses.push(ids.length ? Prisma.sql`"Incident"."id" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
  return Prisma.join(clauses, ' AND ');
}

function verificationSqlWhere(query: z.infer<typeof impactQuerySchema>, period: { from: Date; to: Date }, ids?: string[]) {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`i."isPublic" = TRUE`,
    Prisma.sql`vc."createdAt" >= ${period.from}`,
    Prisma.sql`vc."createdAt" <= ${period.to}`,
  ];
  if (query.category) clauses.push(Prisma.sql`i.category = CAST(${query.category} AS "IncidentCategory")`);
  if (query.departmentId) clauses.push(Prisma.sql`i."departmentId" = ${query.departmentId}`);
  if (ids) clauses.push(ids.length ? Prisma.sql`i.id IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
  return Prisma.join(clauses, ' AND ');
}

communityRouter.get('/impact', async (req, res) => {
  const parsed = impactQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid impact ledger filters', fields: parsed.error.flatten().fieldErrors });
  try {
    const period = impactPeriod(parsed.data);
    const baseWhere = impactBaseWhere(parsed.data, period);
    let exactAreaIds: string[] | undefined;
    let eventAreaIds: string[] | undefined;
    let truncated = false;
    if (parsed.data.centerLatitude !== undefined && parsed.data.centerLongitude !== undefined) {
      const area = {
        centerLatitude: parsed.data.centerLatitude,
        centerLongitude: parsed.data.centerLongitude,
        radiusMeters: parsed.data.radiusMeters!,
      };
      const candidates = await prisma.incident.findMany({
        where: { AND: [baseWhere, areaIncidentWhere(area)] },
        orderBy: { resolvedAt: 'desc' },
        take: 5_001,
        select: { id: true, latitude: true, longitude: true },
      });
      truncated = candidates.length > 5_000;
      exactAreaIds = candidates
        .slice(0, 5_000)
        .filter((record) => distanceMeters(
          { latitude: area.centerLatitude, longitude: area.centerLongitude },
          { latitude: record.latitude, longitude: record.longitude },
        ) <= area.radiusMeters)
        .map((record) => record.id);
      const outcomeCandidates = await prisma.incident.findMany({
        where: {
          isPublic: true,
          ...(parsed.data.category ? { category: parsed.data.category } : {}),
          ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
          OR: [
            { verificationCases: { some: { createdAt: { gte: period.from, lte: period.to } } } },
            { activities: { some: {
              newStatus: 'REOPENED',
              visibility: 'PUBLIC',
              createdAt: { gte: period.from, lte: period.to },
            } } },
          ],
          ...areaIncidentWhere(area),
        },
        orderBy: { updatedAt: 'desc' },
        take: 5_001,
        select: { id: true, latitude: true, longitude: true },
      });
      if (outcomeCandidates.length > 5_000) truncated = true;
      eventAreaIds = outcomeCandidates
        .slice(0, 5_000)
        .filter((record) => distanceMeters(
          { latitude: area.centerLatitude, longitude: area.centerLongitude },
          { latitude: record.latitude, longitude: record.longitude },
        ) <= area.radiusMeters)
        .map((record) => record.id);
    }
    const where: Prisma.IncidentWhereInput = exactAreaIds
      ? { AND: [baseWhere, { id: { in: exactAreaIds } }] }
      : baseWhere;
    const [total, items, categories, departments, verificationGroups, reopenGroups, monthly, timing] = await Promise.all([
      prisma.incident.count({ where }),
      prisma.incident.findMany({
        where,
        orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
        select: impactIncidentSelect,
      }),
      prisma.incident.groupBy({ by: ['category'], where, _count: { _all: true }, orderBy: { category: 'asc' } }),
      prisma.incident.groupBy({ by: ['departmentId'], where, _count: { _all: true }, orderBy: { departmentId: 'asc' } }),
      eventAreaIds && eventAreaIds.length === 0
        ? Promise.resolve([] as Array<{ status: string; count: number }>)
        : prisma.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
            SELECT outcomes.status::text AS status, COUNT(*)::int AS count
            FROM (
              SELECT DISTINCT ON (vc."incidentId") vc.status
              FROM "VerificationCase" vc
              JOIN "Incident" i ON i.id = vc."incidentId"
              WHERE ${verificationSqlWhere(parsed.data, period, eventAreaIds)}
              ORDER BY vc."incidentId", vc."createdAt" DESC, vc.id DESC
            ) outcomes
            WHERE outcomes.status IN (
              'VERIFIED'::"VerificationCaseStatus",
              'REOPENED'::"VerificationCaseStatus",
              'DISPUTED'::"VerificationCaseStatus",
              'REVIEW_REQUIRED'::"VerificationCaseStatus"
            )
            GROUP BY outcomes.status
          `),
      prisma.incidentActivity.groupBy({
        by: ['incidentId'],
        orderBy: { incidentId: 'asc' },
        where: {
          newStatus: 'REOPENED',
          visibility: 'PUBLIC',
          createdAt: { gte: period.from, lte: period.to },
          incident: {
            isPublic: true,
            createdAt: { gte: period.from, lte: period.to },
            ...(parsed.data.category ? { category: parsed.data.category } : {}),
            ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
            ...(eventAreaIds ? { id: { in: eventAreaIds } } : {}),
          },
        },
        take: 5_001,
      }),
      exactAreaIds && exactAreaIds.length === 0
        ? Promise.resolve([] as Array<{ period: Date; count: number }>)
        : prisma.$queryRaw<Array<{ period: Date; count: number }>>(Prisma.sql`
            SELECT date_trunc('month', "resolvedAt") AS period, COUNT(*)::int AS count
            FROM "Incident"
            WHERE ${impactSqlWhere(parsed.data, period, exactAreaIds)}
            GROUP BY period
            ORDER BY period ASC
          `),
      exactAreaIds && exactAreaIds.length === 0
        ? Promise.resolve(null)
        : prisma.$queryRaw<Array<{ averageHours: number | null; sampleSize: number }>>(Prisma.sql`
            SELECT
              CASE WHEN COUNT(*) >= 3 THEN ROUND(AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600)::numeric, 1)::float8 ELSE NULL END AS "averageHours",
              COUNT(*)::int AS "sampleSize"
            FROM "Incident"
            WHERE ${impactSqlWhere(parsed.data, period, exactAreaIds)}
          `).then((rows) => rows[0] ?? null),
    ]);
    const departmentIds = departments.map((entry) => entry.departmentId).filter((id): id is string => id !== null);
    const departmentNames = departmentIds.length
      ? await prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } })
      : [];
    const namesById = new Map(departmentNames.map((department) => [department.id, department.name]));
    const categoryCounts = Object.fromEntries(categories.map((entry) => [entry.category, entry._count._all]));
    const departmentCounts = departments.map((entry) => ({
      department: entry.departmentId ? namesById.get(entry.departmentId) ?? 'Department unavailable' : 'Unassigned',
      verifiedOutcomes: entry._count._all,
    }));
    const verifiedCount = total;
    const reopenedTruncated = reopenGroups.length > 5_000;
    const reopenedCount = Math.min(reopenGroups.length, 5_000);
    const finalOutcomeCount = verificationGroups
      .filter((entry) => entry.status === 'VERIFIED' || entry.status === 'REOPENED')
      .reduce((sum, entry) => sum + entry.count, 0);
    const verifiedDecisionCount = verificationGroups.find((entry) => entry.status === 'VERIFIED')?.count ?? 0;
    const disputedCount = verificationGroups
      .filter((entry) => entry.status === 'DISPUTED' || entry.status === 'REVIEW_REQUIRED')
      .reduce((sum, entry) => sum + entry.count, 0);
    const startLabel = period.from.toISOString().slice(0, 10);
    const endLabel = period.to.toISOString().slice(0, 10);
    const topCategory = categories.slice().sort((a, b) => b._count._all - a._count._all)[0];
    const story = verifiedCount
      ? `From ${startLabel} through ${endLabel}, ${verifiedCount} public civic issue${verifiedCount === 1 ? '' : 's'} were independently verified as resolved${topCategory ? `; ${topCategory._count._all} were ${topCategory.category.replaceAll('_', ' ').toLowerCase()}` : ''}.`
      : `No public incidents were independently verified as resolved from ${startLabel} through ${endLabel}.`;
    return res.json({
      ledger: items.map(serializeImpactRecord),
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
      period: { from: period.from, to: period.to },
      stats: {
        verifiedIssuesResolved: verifiedCount,
        verifiedOutcomesByCategory: categoryCounts,
        verifiedOutcomesByDepartment: departmentCounts,
        verifiedOutcomesOverTime: monthly.map((entry) => ({ period: entry.period.toISOString().slice(0, 7), count: entry.count })),
        reopenedCases: reopenedCount,
        disputedCases: disputedCount,
        verificationRate: finalOutcomeCount >= 5 ? Math.round(verifiedDecisionCount / finalOutcomeCount * 100) : null,
        averageResolutionHours: timing?.averageHours ?? null,
        averageResolutionSampleSize: timing?.sampleSize ?? 0,
      },
      stories: [story],
      dataLimitations: [
        'Only public incidents in RESOLVED status with a VERIFIED verification case are counted as verified impact.',
        'The disputed count includes incidents whose latest verification case is disputed or under review; reopen activity is counted separately and none are treated as verified success.',
        'Verified impact is filtered by resolved date, verification outcomes by verification-case creation date, and reopen counts by reopen event date.',
        'Locations are rounded to about 1 km; averages are withheld below three verified records and verification rates below five final outcomes.',
        ...(truncated ? ['The selected geographic area exceeds the 5,000-record exact-distance processing cap; area metrics may be incomplete.'] : []),
        ...(reopenedTruncated ? ['Reopen-event totals are capped at 5,000 distinct incidents for the selected period.'] : []),
      ],
      truncated,
    });
  } catch (error) {
    return failure(res, error, 'The verified impact ledger is temporarily unavailable');
  }
});

type CampaignRecord = Prisma.CivicCampaignGetPayload<{ include: typeof campaignInclude }>;

function serializeCampaign(record: CampaignRecord, isJoined = false) {
  return {
    id: record.id,
    name: sanitizePublicText(record.name, 120),
    description: sanitizePublicText(record.description, 2_000),
    campaignType: record.campaignType,
    objective: sanitizePublicText(record.objective, 1_000),
    startAt: record.startAt,
    endAt: record.endAt,
    targetAreaLabel: sanitizePublicText(record.targetAreaLabel, 120),
    targetLocation: record.targetLatitude !== null && record.targetLongitude !== null
      ? {
          latitude: roundPublicCoordinate(record.targetLatitude),
          longitude: roundPublicCoordinate(record.targetLongitude),
          radiusMeters: record.radiusMeters,
        }
      : null,
    department: record.department,
    status: record.status,
    createdByRole: record.creator.role,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    participants: record._count.participants,
    linkedPublicReports: record._count.incidentLinks,
    isJoined,
  };
}

async function getManagerScope(role: UserRole, userId: string, departmentId?: string | null) {
  if (role === 'AUTHORITY') {
    const profile = await prisma.authorityProfile.findUnique({
      where: { userId },
      select: { departmentId: true, department: { select: { status: true } } },
    });
    if (!profile || profile.department.status !== 'ACTIVE') return { ok: false as const, status: 403, error: 'An active department assignment is required' };
    if (departmentId && departmentId !== profile.departmentId) return { ok: false as const, status: 403, error: 'Campaigns can only be managed for your assigned department' };
    return { ok: true as const, departmentId: profile.departmentId };
  }
  if (departmentId) {
    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, status: true } });
    if (!department) return { ok: false as const, status: 404, error: 'Department not found' };
    if (department.status !== 'ACTIVE') return { ok: false as const, status: 409, error: 'Campaigns require an active department' };
  }
  return { ok: true as const, departmentId: departmentId ?? undefined };
}

async function findManagedCampaign(role: UserRole, userId: string, campaignId: string) {
  const campaign = await prisma.civicCampaign.findUnique({ where: { id: campaignId }, include: campaignInclude });
  if (!campaign) return { ok: false as const, status: 404, error: 'Campaign not found' };
  const scope = await getManagerScope(role, userId, campaign.departmentId);
  if (!scope.ok) return scope;
  if (role === 'AUTHORITY' && campaign.departmentId !== scope.departmentId) {
    return { ok: false as const, status: 404, error: 'Campaign not found' };
  }
  return { ok: true as const, campaign, departmentId: scope.departmentId };
}

function campaignPublicStatuses(status?: CivicCampaignStatus) {
  const publicStatuses: CivicCampaignStatus[] = ['ACTIVE', 'PAUSED', 'COMPLETED'];
  return status ? (publicStatuses.includes(status) ? [status] : []) : publicStatuses;
}

communityRouter.get('/campaigns/manage', requireAuth, requireRole('ADMIN', 'AUTHORITY'), async (req, res) => {
  const parsed = campaignListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign management filters' });
  try {
    const scope = await getManagerScope(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const where: Prisma.CivicCampaignWhereInput = {
      ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.campaignType ? { campaignType: parsed.data.campaignType } : {}),
      ...(parsed.data.search ? {
        OR: [
          { name: { contains: parsed.data.search, mode: 'insensitive' } },
          { targetAreaLabel: { contains: parsed.data.search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [campaigns, total] = await prisma.$transaction([
      prisma.civicCampaign.findMany({
        where,
        include: campaignInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.civicCampaign.count({ where }),
    ]);
    return res.json({
      campaigns: campaigns.map((campaign) => serializeCampaign(campaign)),
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return failure(res, error, 'Campaign oversight is temporarily unavailable');
  }
});

communityRouter.get('/campaigns', optionalAuth, async (req, res) => {
  const parsed = campaignListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign filters' });
  if (parsed.data.joined && req.user?.role !== 'CITIZEN') {
    return res.status(401).json({ error: 'Sign in as a citizen to filter joined campaigns' });
  }
  try {
    const where: Prisma.CivicCampaignWhereInput = {
      status: { in: campaignPublicStatuses(parsed.data.status) },
      ...(parsed.data.campaignType ? { campaignType: parsed.data.campaignType } : {}),
      ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
      ...(parsed.data.search ? {
        OR: [
          { name: { contains: parsed.data.search, mode: 'insensitive' } },
          { description: { contains: parsed.data.search, mode: 'insensitive' } },
          { targetAreaLabel: { contains: parsed.data.search, mode: 'insensitive' } },
        ],
      } : {}),
      ...(parsed.data.joined === 'true' ? { participants: { some: { userId: req.user!.id, isActive: true } } } : {}),
      ...(parsed.data.joined === 'false' && req.user?.role === 'CITIZEN'
        ? { participants: { none: { userId: req.user.id, isActive: true } } }
        : {}),
    };
    const [campaigns, total] = await prisma.$transaction([
      prisma.civicCampaign.findMany({
        where,
        include: campaignInclude,
        orderBy: [{ startAt: 'asc' }, { createdAt: 'desc' }],
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
      }),
      prisma.civicCampaign.count({ where }),
    ]);
    const memberships = req.user?.role === 'CITIZEN' && campaigns.length
      ? await prisma.campaignParticipant.findMany({
          where: { userId: req.user.id, isActive: true, campaignId: { in: campaigns.map((campaign) => campaign.id) } },
          select: { campaignId: true },
        })
      : [];
    const joinedIds = new Set(memberships.map((item) => item.campaignId));
    return res.json({
      campaigns: campaigns.map((campaign) => serializeCampaign(campaign, joinedIds.has(campaign.id))),
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return failure(res, error, 'Civic campaigns are temporarily unavailable');
  }
});

communityRouter.get('/campaigns/:id', optionalAuth, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Campaign not found' });
  try {
    const campaign = await prisma.civicCampaign.findUnique({
      where: { id },
      include: {
        ...campaignInclude,
        incidentLinks: {
          where: { incident: { isPublic: true } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { incident: { select: communityIncidentSelect } },
        },
        auditEvents: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { action: true, fromStatus: true, toStatus: true, createdAt: true },
        },
      },
    });
    const canManagePrivateCampaign = req.user?.role === 'ADMIN' || req.user?.role === 'AUTHORITY';
    if (!campaign || ['DRAFT', 'CANCELLED'].includes(campaign.status) && !canManagePrivateCampaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    let canSeeManagementHistory = req.user?.role === 'ADMIN';
    if (req.user?.role === 'AUTHORITY') {
      const scope = await getManagerScope(req.user.role, req.user.id);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      if (campaign.departmentId && campaign.departmentId !== scope.departmentId
        || ['DRAFT', 'CANCELLED'].includes(campaign.status) && campaign.departmentId !== scope.departmentId) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      canSeeManagementHistory = campaign.departmentId === scope.departmentId;
    }
    const [membership, verifiedReportCount] = await Promise.all([
      req.user?.role === 'CITIZEN'
        ? prisma.campaignParticipant.findUnique({
            where: { campaignId_userId: { campaignId: id, userId: req.user.id } },
            select: { isActive: true },
          })
        : Promise.resolve(null),
      prisma.campaignIncident.count({
        where: {
          campaignId: id,
          incident: { isPublic: true, status: 'RESOLVED', verificationCases: { some: { status: 'VERIFIED' } } },
        },
      }),
    ]);
    const related = campaign.incidentLinks.map((link) => publicIncident(link.incident));
    return res.json({
      campaign: {
        ...serializeCampaign(campaign, membership?.isActive ?? false),
        verifiedLinkedReports: verifiedReportCount,
        linkedReportVerificationPercent: campaign._count.incidentLinks
          ? Math.round(verifiedReportCount / campaign._count.incidentLinks * 100)
          : null,
        linkedIncidents: related,
        auditHistory: canSeeManagementHistory ? campaign.auditEvents : undefined,
      },
    });
  } catch (error) {
    return failure(res, error, 'Campaign details are temporarily unavailable');
  }
});

communityRouter.post('/campaigns', requireAuth, requireRole('ADMIN', 'AUTHORITY'), campaignLimiter, async (req, res) => {
  const parsed = campaignCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign details', fields: parsed.error.flatten().fieldErrors });
  try {
    const scope = await getManagerScope(req.user!.role, req.user!.id, parsed.data.departmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const created = await prisma.$transaction(async (tx) => {
      const campaign = await tx.civicCampaign.create({
        data: {
          name: parsed.data.name,
          description: parsed.data.description,
          campaignType: parsed.data.campaignType,
          objective: parsed.data.objective,
          startAt: new Date(parsed.data.startAt),
          endAt: new Date(parsed.data.endAt),
          targetAreaLabel: parsed.data.targetAreaLabel,
          targetLatitude: parsed.data.targetLatitude ?? null,
          targetLongitude: parsed.data.targetLongitude ?? null,
          radiusMeters: parsed.data.radiusMeters ?? null,
          departmentId: req.user!.role === 'AUTHORITY' ? scope.departmentId : parsed.data.departmentId ?? null,
          createdByUserId: req.user!.id,
        },
        include: campaignInclude,
      });
      const audit = await tx.campaignAuditEvent.create({
        data: { campaignId: campaign.id, actorUserId: req.user!.id, action: CampaignAuditAction.CREATED },
      });
      return { campaign, audit };
    });
    return res.status(201).json({ campaign: serializeCampaign(created.campaign), auditEventId: created.audit.id });
  } catch (error) {
    return failure(res, error, 'Unable to create the campaign');
  }
});

communityRouter.patch('/campaigns/:id', requireAuth, requireRole('ADMIN', 'AUTHORITY'), campaignLimiter, async (req, res) => {
  const parsed = campaignUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign update', fields: parsed.error.flatten().fieldErrors });
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Campaign not found' });
  try {
    const access = await findManagedCampaign(req.user!.role, req.user!.id, id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const existing = access.campaign;
    const nextStatus = parsed.data.status ?? existing.status;
    const nextDepartmentId = req.user!.role === 'AUTHORITY'
      ? access.departmentId
      : parsed.data.departmentId === undefined ? existing.departmentId : parsed.data.departmentId;
    const scope = await getManagerScope(req.user!.role, req.user!.id, nextDepartmentId);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    if (nextStatus !== existing.status && !isValidCampaignTransition(existing.status, nextStatus)) {
      return res.status(409).json({ error: `Cannot change a ${existing.status.toLowerCase()} campaign to ${nextStatus.toLowerCase()}` });
    }
    if ((existing.status === 'COMPLETED' || existing.status === 'CANCELLED')
      && Object.keys(parsed.data).some((key) => key !== 'status')) {
      return res.status(409).json({ error: 'Completed or cancelled campaigns cannot be edited' });
    }
    const nextStart = parsed.data.startAt ? new Date(parsed.data.startAt) : existing.startAt;
    const nextEnd = parsed.data.endAt ? new Date(parsed.data.endAt) : existing.endAt;
    if (nextEnd <= nextStart) return res.status(400).json({ error: 'Campaign end must be after its start' });
    if (nextStatus === 'ACTIVE' && nextEnd <= new Date()) return res.status(409).json({ error: 'An expired campaign cannot be published or resumed' });
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.civicCampaign.updateMany({
        where: campaignSnapshotWhere(existing),
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.campaignType !== undefined ? { campaignType: parsed.data.campaignType } : {}),
          ...(parsed.data.objective !== undefined ? { objective: parsed.data.objective } : {}),
          ...(parsed.data.startAt !== undefined ? { startAt: nextStart } : {}),
          ...(parsed.data.endAt !== undefined ? { endAt: nextEnd } : {}),
          ...(parsed.data.targetAreaLabel !== undefined ? { targetAreaLabel: parsed.data.targetAreaLabel } : {}),
          ...(parsed.data.targetLatitude !== undefined ? { targetLatitude: parsed.data.targetLatitude } : {}),
          ...(parsed.data.targetLongitude !== undefined ? { targetLongitude: parsed.data.targetLongitude } : {}),
          ...(parsed.data.radiusMeters !== undefined ? { radiusMeters: parsed.data.radiusMeters } : {}),
          ...(parsed.data.departmentId !== undefined && req.user!.role === 'ADMIN' ? { departmentId: parsed.data.departmentId } : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        },
      });
      if (!changed.count) throw new CampaignChangedError();
      const campaign = await tx.civicCampaign.findUnique({ where: { id }, include: campaignInclude });
      if (!campaign) throw new CampaignChangedError();
      const action = nextStatus !== existing.status
        ? getCampaignAuditAction(existing.status, nextStatus)
        : CampaignAuditAction.UPDATED;
      const audit = await tx.campaignAuditEvent.create({
        data: {
          campaignId: id,
          actorUserId: req.user!.id,
          action,
          fromStatus: existing.status,
          toStatus: nextStatus,
          metadata: { changedFields: Object.keys(parsed.data).filter((key) => key !== 'status') },
        },
      });
      return { campaign, audit };
    });
    return res.json({ campaign: serializeCampaign(result.campaign), auditEventId: result.audit.id });
  } catch (error) {
    if (error instanceof CampaignChangedError) return res.status(409).json({ error: error.message });
    return failure(res, error, 'Unable to update the campaign');
  }
});

communityRouter.post('/campaigns/:id/join', requireAuth, requireRole('CITIZEN'), campaignLimiter, async (req, res) => {
  const campaignId = getId(req);
  if (!campaignId) return res.status(404).json({ error: 'Campaign not found' });
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CivicCampaign" WHERE "id" = ${campaignId} FOR UPDATE`;
      const campaign = await tx.civicCampaign.findUnique({
        where: { id: campaignId },
        select: { id: true, status: true, startAt: true, endAt: true },
      });
      if (!campaign || !isCampaignJoinable(campaign)) {
        throw new CampaignChangedError();
      }
      const previous = await tx.campaignParticipant.findUnique({
        where: { campaignId_userId: { campaignId, userId: req.user!.id } },
      });
      if (previous?.isActive) return { participant: previous, changed: false };
      const participant = previous
        ? await tx.campaignParticipant.update({
            where: { id: previous.id },
            data: { isActive: true, joinedAt: new Date(), leftAt: null },
          })
        : await tx.campaignParticipant.create({ data: { campaignId, userId: req.user!.id } });
      await tx.campaignParticipationEvent.create({ data: { participantId: participant.id, action: 'JOINED' } });
      return { participant, changed: true };
    });
    const participants = await prisma.campaignParticipant.count({ where: { campaignId, isActive: true } });
    return res.json({ joined: true, participants, changed: result.changed });
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.json({ joined: true, changed: false });
    if (error instanceof CampaignChangedError) return res.status(409).json({ error: 'This campaign is not open for participation' });
    return failure(res, error, 'Unable to join the campaign');
  }
});

communityRouter.delete('/campaigns/:id/join', requireAuth, requireRole('CITIZEN'), campaignLimiter, async (req, res) => {
  const campaignId = getId(req);
  if (!campaignId) return res.status(404).json({ error: 'Campaign not found' });
  try {
    const participant = await prisma.campaignParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: req.user!.id } },
    });
    if (!participant?.isActive) return res.json({ joined: false, changed: false });
    await prisma.$transaction(async (tx) => {
      const changed = await tx.campaignParticipant.updateMany({
        where: { id: participant.id, isActive: true },
        data: { isActive: false, leftAt: new Date() },
      });
      if (!changed.count) return;
      await tx.campaignParticipationEvent.create({ data: { participantId: participant.id, action: 'LEFT' } });
    });
    const participants = await prisma.campaignParticipant.count({ where: { campaignId, isActive: true } });
    return res.json({ joined: false, participants, changed: true });
  } catch (error) {
    return failure(res, error, 'Unable to leave the campaign');
  }
});

communityRouter.put('/campaigns/:id/incidents/:incidentId', requireAuth, requireRole('ADMIN', 'AUTHORITY'), campaignLimiter, async (req, res) => {
  const campaignId = getId(req);
  const incidentId = getId(req, 'incidentId');
  if (!campaignId || !incidentId) return res.status(404).json({ error: 'Campaign or report not found' });
  try {
    const access = await findManagedCampaign(req.user!.role, req.user!.id, campaignId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.campaign.status === 'COMPLETED' || access.campaign.status === 'CANCELLED') {
      return res.status(409).json({ error: 'Completed or cancelled campaigns cannot be changed' });
    }
    const incident = await prisma.incident.findFirst({
      where: { id: incidentId, isPublic: true },
      select: { id: true, departmentId: true, latitude: true, longitude: true },
    });
    if (!incident) return res.status(404).json({ error: 'Public incident not found' });
    if (req.user!.role === 'AUTHORITY' && incident.departmentId !== access.departmentId) {
      return res.status(404).json({ error: 'Public incident not found in your department' });
    }
    if (access.campaign.targetLatitude !== null && access.campaign.targetLatitude !== undefined
      && access.campaign.targetLongitude !== null && access.campaign.targetLongitude !== undefined
      && distanceMeters(
        { latitude: access.campaign.targetLatitude, longitude: access.campaign.targetLongitude },
        { latitude: incident.latitude, longitude: incident.longitude },
      ) > (access.campaign.radiusMeters ?? 0)) {
      return res.status(400).json({ error: 'The incident is outside the campaign target area' });
    }
    const link = await prisma.$transaction(async (tx) => {
      const created = await tx.campaignIncident.create({
        data: { campaignId, incidentId, linkedByUserId: req.user!.id },
      });
      await tx.campaignAuditEvent.create({
        data: {
          campaignId,
          actorUserId: req.user!.id,
          action: CampaignAuditAction.INCIDENT_LINKED,
          metadata: { incidentId },
        },
      });
      return created;
    });
    return res.status(201).json({ linked: true, linkId: link.id });
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: 'The incident is already linked to this campaign' });
    return failure(res, error, 'Unable to link the public incident to this campaign');
  }
});

communityRouter.delete('/campaigns/:id/incidents/:incidentId', requireAuth, requireRole('ADMIN', 'AUTHORITY'), campaignLimiter, async (req, res) => {
  const campaignId = getId(req);
  const incidentId = getId(req, 'incidentId');
  if (!campaignId || !incidentId) return res.status(404).json({ error: 'Campaign or report not found' });
  try {
    const access = await findManagedCampaign(req.user!.role, req.user!.id, campaignId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.campaignIncident.deleteMany({ where: { campaignId, incidentId } });
      if (deleted.count) {
        await tx.campaignAuditEvent.create({
          data: {
            campaignId,
            actorUserId: req.user!.id,
            action: CampaignAuditAction.INCIDENT_UNLINKED,
            metadata: { incidentId },
          },
        });
      }
      return deleted.count;
    });
    if (!result) return res.status(404).json({ error: 'Linked incident not found' });
    return res.json({ linked: false });
  } catch (error) {
    return failure(res, error, 'Unable to unlink the public incident');
  }
});

async function materializeNotifications(userId: string) {
  const recentSince = new Date(Date.now() - 30 * 86_400_000);
  const [areas, supports, participations] = await Promise.all([
    prisma.followedArea.findMany({
      where: { userId, isActive: true },
      select: { id: true, name: true, centerLatitude: true, centerLongitude: true, radiusMeters: true, followedAt: true },
      take: 20,
    }),
    prisma.incidentSupport.findMany({
      where: {
        userId,
        isActive: true,
        incident: { isPublic: true, activities: { some: { visibility: 'PUBLIC', createdAt: { gte: recentSince } } } },
      },
      include: {
        incident: {
          select: {
            id: true,
            activities: {
              where: { visibility: 'PUBLIC', createdAt: { gte: recentSince } },
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: { id: true, createdAt: true, newStatus: true },
            },
          },
        },
      },
      take: 100,
    }),
    prisma.campaignParticipant.findMany({
      where: { userId, isActive: true, campaign: { status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] } } },
      include: { campaign: { select: { id: true, name: true, updatedAt: true } } },
      orderBy: { campaign: { updatedAt: 'desc' } },
      take: 100,
    }),
  ]);
  const notifications: Prisma.CivicNotificationCreateManyInput[] = [];
  for (const support of supports) {
    const activity = support.incident.activities.find((item) => item.createdAt > support.supportedAt);
    if (!activity) continue;
    notifications.push({
      recipientId: userId,
      type: 'SUPPORTED_INCIDENT_UPDATE',
      title: 'An issue you support was updated',
      message: 'A public update was posted to an incident you support.',
      entityType: 'INCIDENT',
      entityId: support.incident.id,
      sourceKey: `support:${support.incident.id}:${activity.id}`,
      createdAt: activity.createdAt,
    });
  }
  for (const area of areas) {
    const incidents = await loadAreaIncidents(area);
    for (const incident of incidents) {
      const recentPublicActivity = incident.activities.find((activity) => activity.createdAt > area.followedAt);
      if (!recentPublicActivity || recentPublicActivity.createdAt < recentSince) continue;
      const verified = incident.status === 'RESOLVED' && incident.verificationCases[0]?.status === 'VERIFIED';
      notifications.push({
        recipientId: userId,
        type: verified ? 'VERIFIED_IMPROVEMENT' : 'FOLLOWED_AREA_ACTIVITY',
        title: verified ? 'A verified improvement was recorded nearby' : 'New public activity in a followed area',
        message: 'A public civic update is available in an area you follow.',
        entityType: 'INCIDENT',
        entityId: incident.id,
        sourceKey: `area:${area.id}:incident:${incident.id}:${verified ? 'verified' : recentPublicActivity.id}`,
        createdAt: recentPublicActivity.createdAt,
      });
    }
  }
  for (const participation of participations) {
    if (participation.campaign.updatedAt <= participation.joinedAt || participation.campaign.updatedAt < recentSince) continue;
    notifications.push({
      recipientId: userId,
      type: 'CAMPAIGN_UPDATE',
      title: 'A civic campaign you joined was updated',
      message: 'A campaign you participate in has new information.',
      entityType: 'CAMPAIGN',
      entityId: participation.campaign.id,
      sourceKey: `campaign:${participation.campaign.id}:${participation.campaign.updatedAt.toISOString()}`,
      createdAt: participation.campaign.updatedAt,
    });
  }
  if (!notifications.length) return 0;
  const result = await prisma.civicNotification.createMany({ data: notifications, skipDuplicates: true });
  return result.count;
}

communityRouter.get('/me/dashboard', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  try {
    const userId = req.user!.id;
    const [activeSupports, activeAreas, activeCampaigns, unreadNotifications, recentSupports, recentCampaigns] = await Promise.all([
      prisma.incidentSupport.count({ where: { userId, isActive: true } }),
      prisma.followedArea.count({ where: { userId, isActive: true } }),
      prisma.campaignParticipant.count({
        where: { userId, isActive: true, campaign: { status: { in: ['ACTIVE', 'PAUSED'] } } },
      }),
      prisma.civicNotification.count({ where: { recipientId: userId, readAt: null } }),
      prisma.incidentSupport.findMany({
        where: { userId, isActive: true, incident: { isPublic: true } },
        orderBy: { supportedAt: 'desc' },
        take: 5,
        select: {
          supportedAt: true,
          incident: { select: { id: true, title: true, category: true, status: true } },
        },
      }),
      prisma.campaignParticipant.findMany({
        where: { userId, isActive: true, campaign: { status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] } } },
        orderBy: { joinedAt: 'desc' },
        take: 5,
        select: {
          joinedAt: true,
          campaign: { select: { id: true, name: true, status: true, endAt: true } },
        },
      }),
    ]);
    return res.json({
      summary: { activeSupports, activeAreas, activeCampaigns, unreadNotifications },
      recentSupports: recentSupports.map((item) => ({ ...item.incident, supportedAt: item.supportedAt })),
      campaigns: recentCampaigns.map((item) => ({ ...item.campaign, joinedAt: item.joinedAt })),
    });
  } catch (error) {
    return failure(res, error, 'Your community dashboard is temporarily unavailable');
  }
});

communityRouter.get('/me/participation', requireAuth, requireRole('CITIZEN'), async (req, res) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid participation history filters' });
  try {
    const userId = req.user!.id;
    const [supportEvents, campaignEvents, areas] = await Promise.all([
      prisma.incidentSupportEvent.findMany({
        where: { userId, incident: { isPublic: true } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          action: true,
          createdAt: true,
          incident: { select: { id: true, title: true, category: true, status: true } },
        },
      }),
      prisma.campaignParticipationEvent.findMany({
        where: { participant: { userId } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          action: true,
          createdAt: true,
          participant: { select: { campaign: { select: { id: true, name: true, status: true } } } },
        },
      }),
      prisma.followedArea.findMany({
        where: { userId },
        orderBy: { followedAt: 'desc' },
        take: 100,
        select: { id: true, name: true, followedAt: true, unfollowedAt: true },
      }),
    ]);
    const events = [
      ...supportEvents.map((event) => ({
        id: event.id,
        type: event.action,
        createdAt: event.createdAt,
        subject: { type: 'INCIDENT', ...event.incident },
      })),
      ...campaignEvents.map((event) => ({
        id: event.id,
        type: event.action,
        createdAt: event.createdAt,
        subject: { type: 'CAMPAIGN', ...event.participant.campaign },
      })),
      ...areas.flatMap((area) => [
        { id: `${area.id}:followed`, type: 'AREA_FOLLOWED', createdAt: area.followedAt, subject: { type: 'AREA', id: area.id, name: area.name } },
        ...(area.unfollowedAt
          ? [{ id: `${area.id}:unfollowed`, type: 'AREA_UNFOLLOWED', createdAt: area.unfollowedAt, subject: { type: 'AREA', id: area.id, name: area.name } }]
          : []),
      ]),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = (parsed.data.page - 1) * parsed.data.limit;
    return res.json({
      events: events.slice(offset, offset + parsed.data.limit),
      pagination: {
        page: parsed.data.page,
        limit: parsed.data.limit,
        total: events.length,
        pages: Math.ceil(events.length / parsed.data.limit),
      },
    });
  } catch (error) {
    return failure(res, error, 'Participation history is temporarily unavailable');
  }
});

communityRouter.get('/notifications', requireAuth, requireRole('CITIZEN'), notificationLimiter, async (req, res) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid notification filters' });
  try {
    const userId = req.user!.id;
    const where = { recipientId: userId };
    const [notifications, total, unread] = await prisma.$transaction([
      prisma.civicNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (parsed.data.page - 1) * parsed.data.limit,
        take: parsed.data.limit,
        select: { id: true, type: true, title: true, message: true, entityType: true, entityId: true, readAt: true, createdAt: true },
      }),
      prisma.civicNotification.count({ where }),
      prisma.civicNotification.count({ where: { ...where, readAt: null } }),
    ]);
    return res.json({
      notifications,
      unread,
      pagination: { page: parsed.data.page, limit: parsed.data.limit, total, pages: Math.ceil(total / parsed.data.limit) },
    });
  } catch (error) {
    return failure(res, error, 'Notifications are temporarily unavailable');
  }
});

communityRouter.post('/notifications/materialize', requireAuth, requireRole('CITIZEN'), notificationLimiter, async (req, res) => {
  try {
    const created = await materializeNotifications(req.user!.id);
    return res.json({ created });
  } catch (error) {
    return failure(res, error, 'Unable to refresh notifications');
  }
});

communityRouter.post('/notifications/read-all', requireAuth, requireRole('CITIZEN'), notificationLimiter, async (req, res) => {
  try {
    const result = await prisma.civicNotification.updateMany({
      where: { recipientId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ markedRead: result.count });
  } catch (error) {
    return failure(res, error, 'Unable to mark notifications as read');
  }
});

communityRouter.post('/notifications/:id/read', requireAuth, requireRole('CITIZEN'), notificationLimiter, async (req, res) => {
  const id = getId(req);
  if (!id) return res.status(404).json({ error: 'Notification not found' });
  try {
    const result = await prisma.civicNotification.updateMany({
      where: { id, recipientId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    const exists = result.count > 0
      || await prisma.civicNotification.findFirst({ where: { id, recipientId: req.user!.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Notification not found' });
    return res.json({ read: true });
  } catch (error) {
    return failure(res, error, 'Unable to mark this notification as read');
  }
});
