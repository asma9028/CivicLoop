import { createHash } from 'node:crypto';
import type { IncidentCategory, IncidentStatus, PriorityBand, RecommendationPriority, Severity, VerificationCaseStatus } from '@prisma/client';
import { intelligenceConfig } from '../../config/intelligence.js';

const terminalStatuses: IncidentStatus[] = ['RESOLVED', 'REJECTED', 'DUPLICATE'];
const categories: IncidentCategory[] = ['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER'];
const severityValues: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface IntelligenceIncident {
  id: string;
  title: string;
  category: IncidentCategory;
  severity: Severity;
  status: IncidentStatus;
  latitude: number;
  longitude: number;
  createdAt: Date;
  resolvedAt: Date | null;
  departmentId: string | null;
  departmentName: string | null;
  duplicateOfIncidentId: string | null;
  reopenCount: number;
  disputeCount: number;
  verificationStatuses: VerificationCaseStatus[];
  verifiedCount: number;
}

export interface IntelligencePeriod {
  from: Date;
  to: Date;
}

export interface Hotspot {
  id: string;
  latitude: number;
  longitude: number;
  incidentCount: number;
  dominantCategory: IncidentCategory;
  categoryCounts: Record<string, number>;
  severityDistribution: Record<string, number>;
  trend: Array<{ period: string; incidents: number }>;
  repeatedIssueCount: number;
  reopenedIncidents: number;
  verifiedResolutions: number;
  disputedResolutions: number;
  unresolvedIncidents: number;
  overdueIncidents: number;
  department: { id: string; name: string } | null;
  intensity: number;
  riskScore: number;
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  riskExplanation: string;
  detectedAt: string;
  incidentIds: string[];
}

export interface RecurringIssue {
  id: string;
  category: IncidentCategory;
  latitude: number;
  longitude: number;
  incidentCount: number;
  independentReports: number;
  duplicateReports: number;
  reopenedIncidents: number;
  disputedResolutions: number;
  verifiedResolutions: number;
  recurrenceIntervalsDays: number[];
  averageRecurrenceDays: number | null;
  departments: Array<{ id: string; name: string }>;
  incidentIds: string[];
  firstReportedAt: string;
  lastReportedAt: string;
}

export interface RecommendationDraft {
  recommendationKey: string;
  title: string;
  description: string;
  areaLabel: string;
  latitude: number;
  longitude: number;
  category: IncidentCategory;
  riskScore: number;
  priority: RecommendationPriority;
  supportingMetrics: {
    incidentCount: number;
    repeatedIssueCount: number;
    reopenedIncidents: number;
    overdueIncidents: number;
    disputedResolutions: number;
    verifiedResolutions: number;
    riskLevel: string;
  };
  recommendedAction: string;
  responsibleDepartmentId: string | null;
}

export interface PeriodComparison {
  current: IntelligencePeriod;
  previous: IntelligencePeriod;
}

const radians = (degrees: number) => degrees * Math.PI / 180;

export function distanceMeters(a: Pick<IntelligenceIncident, 'latitude' | 'longitude'>, b: Pick<IntelligenceIncident, 'latitude' | 'longitude'>) {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function spatialCell(incident: Pick<IntelligenceIncident, 'latitude' | 'longitude'>, cellMeters: number) {
  const x = incident.longitude * 111_320 * Math.cos(radians(incident.latitude));
  const y = incident.latitude * 110_574;
  return { x: Math.floor(x / cellMeters), y: Math.floor(y / cellMeters) };
}

export function clusterIncidents(
  incidents: IntelligenceIncident[],
  radiusMeters = intelligenceConfig.hotspotRadiusMeters,
  minIncidents = intelligenceConfig.hotspotMinIncidents,
) {
  const buckets = new Map<string, number[]>();
  const cells = incidents.map((incident, index) => {
    const cell = spatialCell(incident, radiusMeters);
    const key = `${cell.x}:${cell.y}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
    return cell;
  });
  const visited = new Uint8Array(incidents.length);
  const assigned = new Int32Array(incidents.length).fill(-1);
  const clusters: IntelligenceIncident[][] = [];
  const neighborsFor = (index: number) => {
    const cell = cells[index];
    const neighbors: number[] = [];
    for (let x = cell.x - 1; x <= cell.x + 1; x += 1) {
      for (let y = cell.y - 1; y <= cell.y + 1; y += 1) {
        for (const candidate of buckets.get(`${x}:${y}`) ?? []) {
          if (distanceMeters(incidents[index], incidents[candidate]) <= radiusMeters) neighbors.push(candidate);
        }
      }
    }
    return neighbors;
  };

  for (let index = 0; index < incidents.length; index += 1) {
    if (visited[index]) continue;
    visited[index] = 1;
    const neighbors = neighborsFor(index);
    if (neighbors.length < minIncidents) continue;
    const clusterIndex = clusters.length;
    const cluster: IntelligenceIncident[] = [];
    clusters.push(cluster);
    const queue = [...neighbors];
    const queued = new Uint8Array(incidents.length);
    for (const candidate of queue) queued[candidate] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const candidate = queue[cursor];
      if (!visited[candidate]) {
        visited[candidate] = 1;
        const candidateNeighbors = neighborsFor(candidate);
        if (candidateNeighbors.length >= minIncidents) {
          for (const neighbor of candidateNeighbors) {
            if (!queued[neighbor]) {
              queue.push(neighbor);
              queued[neighbor] = 1;
            }
          }
        }
      }
      if (assigned[candidate] === -1) {
        assigned[candidate] = clusterIndex;
        cluster.push(incidents[candidate]);
      }
    }
  }
  return clusters;
}

function orderedCategoryCounts(incidents: IntelligenceIncident[]) {
  const counts: Record<string, number> = Object.fromEntries(categories.map((category) => [category, 0]));
  for (const incident of incidents) counts[incident.category] += 1;
  return counts;
}

function makeRiskExplanation(cluster: {
  incidentCount: number;
  severityDistribution: Record<string, number>;
  repeatedIssueCount: number;
  reopenedIncidents: number;
  overdueIncidents: number;
  disputedResolutions: number;
}) {
  const reasons: string[] = [];
  if (cluster.incidentCount >= 5) reasons.push(`${cluster.incidentCount} nearby reports indicate concentrated demand`);
  if (cluster.repeatedIssueCount) reasons.push(`${cluster.repeatedIssueCount} recurring issue groups were detected`);
  const higherSeverity = (cluster.severityDistribution.HIGH ?? 0) + (cluster.severityDistribution.CRITICAL ?? 0);
  if (higherSeverity) reasons.push(`${higherSeverity} reports are marked high or critical severity`);
  if (cluster.overdueIncidents) reasons.push(`${cluster.overdueIncidents} incidents exceed the configured response threshold`);
  if (cluster.reopenedIncidents) reasons.push(`${cluster.reopenedIncidents} incidents have reopening history`);
  if (cluster.disputedResolutions) reasons.push(`${cluster.disputedResolutions} resolutions are disputed or under review`);
  return reasons.length
    ? `Risk is elevated because ${reasons.join(', ')}. These are associations in reported data, not proof of cause.`
    : 'Risk is based on the observed report volume, severity, recurrence, overdue incidents, and verification history; the available evidence shows no single dominant driver.';
}

export function calculateRiskScore(input: {
  incidentCount: number;
  severityDistribution: Record<string, number>;
  repeatedIssueCount: number;
  reopenedIncidents: number;
  overdueIncidents: number;
  disputedResolutions: number;
}) {
  if (input.incidentCount < intelligenceConfig.hotspotMinIncidents) {
    return { score: 0, level: 'LOW' as const, sufficientData: false };
  }
  const severityPoints: Record<string, number> = { LOW: 20, MEDIUM: 45, HIGH: 70, CRITICAL: 100 };
  const severityWeighted = severityValues.reduce(
    (sum, severity) => sum + (input.severityDistribution[severity] ?? 0) * severityPoints[severity],
    0,
  );
  const weights = intelligenceConfig.riskWeights;
  const density = Math.min(input.incidentCount / 10, 1) * 100;
  const severity = severityWeighted / input.incidentCount;
  const recurrence = Math.min(input.repeatedIssueCount / 5, 1) * 100;
  const overdue = Math.min(input.overdueIncidents / Math.max(input.incidentCount * 0.5, 1), 1) * 100;
  const disputeReopen = Math.min((input.disputedResolutions + input.reopenedIncidents) / Math.max(input.incidentCount * 0.5, 1), 1) * 100;
  const score = Math.round(
    density * weights.density / 100
    + severity * weights.severity / 100
    + recurrence * weights.recurrence / 100
    + overdue * weights.overdue / 100
    + disputeReopen * weights.disputeReopen / 100,
  );
  return {
    score,
    level: score >= 75 ? 'CRITICAL' as const : score >= 55 ? 'HIGH' as const : score >= 35 ? 'MODERATE' as const : 'LOW' as const,
    sufficientData: true,
  };
}

function monthBucket(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function trendBuckets(incidents: IntelligenceIncident[]) {
  const counts = new Map<string, number>();
  for (const incident of incidents) counts.set(monthBucket(incident.createdAt), (counts.get(monthBucket(incident.createdAt)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, count]) => ({ period, incidents: count }));
}

function hotspotId(incidents: IntelligenceIncident[], latitude: number, longitude: number) {
  const key = incidents.map((incident) => incident.id).sort().join('|');
  return `hotspot_${createHash('sha256').update(key || `${latitude},${longitude}`).digest('hex').slice(0, 12)}`;
}

function categoryMaximum(counts: Record<string, number>): IncidentCategory {
  return categories.reduce((best, category) => counts[category] > counts[best] ? category : best, categories[0]);
}

export function findRecurringIssues(
  incidents: IntelligenceIncident[],
  radiusMeters = intelligenceConfig.recurrenceRadiusMeters,
  windowDays = intelligenceConfig.recurrenceWindowDays,
): RecurringIssue[] {
  const groups = new Map<IncidentCategory, IntelligenceIncident[]>();
  for (const incident of incidents) {
    const group = groups.get(incident.category) ?? [];
    group.push(incident);
    groups.set(incident.category, group);
  }
  const results: RecurringIssue[] = [];
  for (const [category, items] of groups) {
    const sorted = items.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const parent = sorted.map((_, index) => index);
    const componentStart = sorted.map((item) => item.createdAt.getTime());
    const componentEnd = sorted.map((item) => item.createdAt.getTime());
    const find = (value: number): number => {
      if (parent[value] !== value) parent[value] = find(parent[value]);
      return parent[value];
    };
    const unite = (a: number, b: number) => { parent[find(a)] = find(b); };
    const index = new Map<string, number[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const cell = spatialCell(sorted[i], radiusMeters);
      const key = `${cell.x}:${cell.y}`;
      const candidates: number[] = [];
      for (let x = cell.x - 1; x <= cell.x + 1; x += 1) {
        for (let y = cell.y - 1; y <= cell.y + 1; y += 1) {
          candidates.push(...(index.get(`${x}:${y}`) ?? []));
        }
      }
      for (const otherIndex of candidates) {
        const older = sorted[otherIndex];
        const elapsedDays = Math.abs(sorted[i].createdAt.getTime() - older.createdAt.getTime()) / 86_400_000;
        if (elapsedDays > windowDays || distanceMeters(sorted[i], older) > radiusMeters) continue;
        const currentRoot = find(i);
        const otherRoot = find(otherIndex);
        if (currentRoot === otherRoot) continue;
        const combinedStart = Math.min(componentStart[currentRoot], componentStart[otherRoot]);
        const combinedEnd = Math.max(componentEnd[currentRoot], componentEnd[otherRoot]);
        if (combinedEnd - combinedStart > windowDays * 86_400_000) continue;
        unite(otherRoot, currentRoot);
        componentStart[currentRoot] = combinedStart;
        componentEnd[currentRoot] = combinedEnd;
      }
      const bucket = index.get(key) ?? [];
      bucket.push(i);
      index.set(key, bucket);
    }
    const clusters = new Map<number, IntelligenceIncident[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const root = find(i);
      const cluster = clusters.get(root) ?? [];
      cluster.push(sorted[i]);
      clusters.set(root, cluster);
    }
    for (const cluster of clusters.values()) {
      const uniqueReports = cluster.filter((item) => !item.duplicateOfIncidentId);
      const duplicateReports = cluster.length - uniqueReports.length;
      const reopenedIncidents = uniqueReports.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length;
      if (uniqueReports.length < 3 && !(uniqueReports.length >= 2 && reopenedIncidents > 0)) continue;
      const recurrenceIntervalsDays = uniqueReports.slice(1).map((item, index) =>
        Math.max(0, Math.round((item.createdAt.getTime() - uniqueReports[index].createdAt.getTime()) / 86_400_000)),
      );
      const latitude = uniqueReports.reduce((sum, item) => sum + item.latitude, 0) / uniqueReports.length;
      const longitude = uniqueReports.reduce((sum, item) => sum + item.longitude, 0) / uniqueReports.length;
      const departmentIds = new Map<string, string>();
      for (const item of uniqueReports) {
        if (item.departmentId && item.departmentName) departmentIds.set(item.departmentId, item.departmentName);
      }
      const departments = [...departmentIds.entries()].map(([id, name]) => ({ id, name }));
      const key = `${category}:${Math.round(latitude * 100)}:${Math.round(longitude * 100)}:${uniqueReports.map((item) => item.id).sort().join('|')}`;
      results.push({
        id: `recurrence_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
        category,
        latitude,
        longitude,
        incidentCount: cluster.length,
        independentReports: uniqueReports.length,
        duplicateReports,
        reopenedIncidents,
        disputedResolutions: uniqueReports.reduce((sum, item) => sum + item.disputeCount, 0),
        verifiedResolutions: uniqueReports.reduce((sum, item) => sum + item.verifiedCount, 0),
        recurrenceIntervalsDays,
        averageRecurrenceDays: recurrenceIntervalsDays.length
          ? Math.round(recurrenceIntervalsDays.reduce((sum, value) => sum + value, 0) / recurrenceIntervalsDays.length)
          : null,
        departments,
        incidentIds: uniqueReports.map((item) => item.id),
        firstReportedAt: uniqueReports[0].createdAt.toISOString(),
        lastReportedAt: uniqueReports[uniqueReports.length - 1].createdAt.toISOString(),
      });
    }
  }
  return results.sort((a, b) => b.incidentCount - a.incidentCount || b.reopenedIncidents - a.reopenedIncidents);
}

export function detectHotspots(
  incidents: IntelligenceIncident[],
  options: { radiusMeters?: number; minIncidents?: number; recurringIssues?: RecurringIssue[]; overdueHours?: number } = {},
): Hotspot[] {
  const minIncidents = options.minIncidents ?? intelligenceConfig.hotspotMinIncidents;
  const groups = clusterIncidents(incidents, options.radiusMeters ?? intelligenceConfig.hotspotRadiusMeters, minIncidents);
  const recurrences = options.recurringIssues ?? findRecurringIssues(incidents);
  const now = new Date();
  return groups.map((group) => {
    const latitude = group.reduce((sum, item) => sum + item.latitude, 0) / group.length;
    const longitude = group.reduce((sum, item) => sum + item.longitude, 0) / group.length;
    const categoryCounts = orderedCategoryCounts(group);
    const severityDistribution: Record<string, number> = Object.fromEntries(severityValues.map((severity) => [severity, 0]));
    for (const item of group) severityDistribution[item.severity] += 1;
    const reopenedIncidents = group.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length;
    const disputedResolutions = group.reduce((sum, item) => sum + item.disputeCount, 0);
    const verifiedResolutions = group.reduce((sum, item) => sum + item.verifiedCount, 0);
    const unresolvedIncidents = group.filter((item) => !terminalStatuses.includes(item.status)).length;
    const overdueThreshold = options.overdueHours ?? intelligenceConfig.overdueHours;
    const overdueIncidents = group.filter((item) =>
      !terminalStatuses.includes(item.status) && now.getTime() - item.createdAt.getTime() > overdueThreshold * 3_600_000,
    ).length;
    const matchingRecurrences = recurrences.filter((recurrence) =>
      distanceMeters({ latitude, longitude }, recurrence) <= (options.radiusMeters ?? intelligenceConfig.hotspotRadiusMeters),
    );
    const repeatedIssueCount = matchingRecurrences.length;
    const risk = calculateRiskScore({
      incidentCount: group.length,
      severityDistribution,
      repeatedIssueCount,
      reopenedIncidents,
      overdueIncidents,
      disputedResolutions,
    });
    const departments = new Map<string, { id: string; name: string; count: number }>();
    for (const item of group) {
      if (!item.departmentId || !item.departmentName) continue;
      const entry = departments.get(item.departmentId) ?? { id: item.departmentId, name: item.departmentName, count: 0 };
      entry.count += 1;
      departments.set(item.departmentId, entry);
    }
    const dominantDepartment = [...departments.values()].sort((a, b) => b.count - a.count)[0] ?? null;
    const facts = {
      incidentCount: group.length,
      severityDistribution,
      repeatedIssueCount,
      reopenedIncidents,
      overdueIncidents,
      disputedResolutions,
    };
    return {
      id: hotspotId(group, latitude, longitude),
      latitude,
      longitude,
      incidentCount: group.length,
      dominantCategory: categoryMaximum(categoryCounts),
      categoryCounts,
      severityDistribution,
      trend: trendBuckets(group),
      repeatedIssueCount,
      reopenedIncidents,
      verifiedResolutions,
      disputedResolutions,
      unresolvedIncidents,
      overdueIncidents,
      department: dominantDepartment ? { id: dominantDepartment.id, name: dominantDepartment.name } : null,
      intensity: Math.min(100, Math.round(group.length / 10 * 100)),
      riskScore: risk.score,
      riskLevel: risk.level,
      riskExplanation: risk.sufficientData
        ? makeRiskExplanation(facts)
        : 'Insufficient reports to classify area risk. Continue to monitor; no risk level is inferred.',
      detectedAt: now.toISOString(),
      incidentIds: group.map((item) => item.id),
    };
  }).sort((a, b) => b.riskScore - a.riskScore || b.incidentCount - a.incidentCount);
}

export function buildRecommendations(hotspots: Hotspot[]): RecommendationDraft[] {
  return hotspots.filter((hotspot) =>
    hotspot.riskScore >= 35 || hotspot.repeatedIssueCount > 0 || hotspot.reopenedIncidents > 0,
  ).map((hotspot) => {
    const title = hotspot.reopenedIncidents
      ? `Reassess recurring ${hotspot.dominantCategory.toLowerCase().replaceAll('_', ' ')} work`
      : hotspot.repeatedIssueCount
        ? `Inspect recurring ${hotspot.dominantCategory.toLowerCase().replaceAll('_', ' ')} issues`
        : `Proactively inspect ${hotspot.dominantCategory.toLowerCase().replaceAll('_', ' ')} reports`;
    const recommendedAction = hotspot.reopenedIncidents
      ? 'Review prior work and verify the underlying cause before scheduling another repair.'
      : hotspot.dominantCategory === 'DRAINAGE'
        ? 'Inspect nearby drains and flow paths before the next high-rainfall period.'
        : hotspot.dominantCategory === 'ROAD'
          ? 'Survey nearby road surfaces and scope preventive maintenance for the affected area.'
          : hotspot.dominantCategory === 'ELECTRICITY'
            ? 'Inspect nearby lighting assets and check for repeated component failures.'
            : `Inspect the area for the recurring ${hotspot.dominantCategory.toLowerCase().replaceAll('_', ' ')} service issue.`;
    const recommendationKey = `hotspot:${hotspot.id}`;
    const metrics = {
      incidentCount: hotspot.incidentCount,
      repeatedIssueCount: hotspot.repeatedIssueCount,
      reopenedIncidents: hotspot.reopenedIncidents,
      overdueIncidents: hotspot.overdueIncidents,
      disputedResolutions: hotspot.disputedResolutions,
      verifiedResolutions: hotspot.verifiedResolutions,
      riskLevel: hotspot.riskLevel,
    };
    return {
      recommendationKey,
      title,
      description: `${hotspot.riskExplanation} This is an inspection recommendation based on aggregated reports, not a predicted fact or a new citizen incident.`,
      areaLabel: `${hotspot.latitude.toFixed(3)}, ${hotspot.longitude.toFixed(3)} area`,
      latitude: hotspot.latitude,
      longitude: hotspot.longitude,
      category: hotspot.dominantCategory,
      riskScore: hotspot.riskScore,
      priority: hotspot.riskScore >= 75 ? 'URGENT' : hotspot.riskScore >= 55 ? 'HIGH' : hotspot.riskScore >= 35 ? 'MEDIUM' : 'LOW',
      supportingMetrics: metrics,
      recommendedAction,
      responsibleDepartmentId: hotspot.department?.id ?? null,
    };
  });
}

export function compareCategoryTrends(current: IntelligenceIncident[], previous: IntelligenceIncident[]) {
  const currentCounts = orderedCategoryCounts(current);
  const previousCounts = orderedCategoryCounts(previous);
  return categories.map((category) => {
    const currentCount = currentCounts[category];
    const previousCount = previousCounts[category];
    return {
      category,
      current: currentCount,
      previous: previousCount,
      changePercent: previousCount ? Math.round((currentCount - previousCount) / previousCount * 100) : null,
      trend: currentCount === previousCount ? 'STABLE' : currentCount > previousCount ? 'INCREASING' : 'DECREASING',
      comparison: previousCount === 0 && currentCount > 0 ? 'New activity; prior period had zero reports' : null,
    };
  });
}

export function summarizeIntelligence(
  incidents: IntelligenceIncident[],
  period: IntelligencePeriod,
  options: { minIncidents?: number; radiusMeters?: number; overdueHours?: number } = {},
) {
  const recurrences = findRecurringIssues(incidents);
  const hotspots = detectHotspots(incidents, { ...options, recurringIssues: recurrences });
  const statusCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const incident of incidents) {
    statusCounts[incident.status] = (statusCounts[incident.status] ?? 0) + 1;
    severityCounts[incident.severity] = (severityCounts[incident.severity] ?? 0) + 1;
  }
  const openCount = incidents.filter((incident) => !terminalStatuses.includes(incident.status)).length;
  const resolvedCount = incidents.filter((incident) => incident.status === 'RESOLVED').length;
  const verifiedCount = incidents.reduce((sum, incident) => sum + incident.verifiedCount, 0);
  const disputedCount = incidents.reduce((sum, incident) => sum + incident.disputeCount, 0);
  const reopenedCount = incidents.filter((incident) => incident.status === 'REOPENED' || incident.reopenCount > 0).length;
  const overdueCount = incidents.filter((incident) =>
    !terminalStatuses.includes(incident.status) && Date.now() - incident.createdAt.getTime() > (options.overdueHours ?? intelligenceConfig.overdueHours) * 3_600_000,
  ).length;
  const verifiedAndReopened = verifiedCount + reopenedCount;
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    metrics: {
      totalReported: incidents.length,
      open: openCount,
      resolved: resolvedCount,
      verifiedResolutions: verifiedCount,
      disputedResolutions: disputedCount,
      reopenedIncidents: reopenedCount,
      overdueUnresolved: overdueCount,
      verificationSuccessRate: verifiedAndReopened >= 5 ? Math.round(verifiedCount / verifiedAndReopened * 100) : null,
      recurringIssueCount: recurrences.length,
      emergingHotspotCount: hotspots.filter((hotspot) => hotspot.incidentCount >= 5 && hotspot.trend.length > 1).length,
      sampleSize: incidents.length,
    },
    byCategory: orderedCategoryCounts(incidents),
    bySeverity: severityCounts,
    byStatus: statusCounts,
    monthlyTrend: trendBuckets(incidents),
    hotspots,
    recurrences,
    dataLimitations: [
      `At least ${options.minIncidents ?? intelligenceConfig.hotspotMinIncidents} nearby reports are required before an area is classified as a hotspot.`,
      'Coordinates reflect citizen-provided reports; density indicates co-location and does not establish cause.',
      'Incident rows are capped by the API query limit. Metrics include a truncation flag when the limit is reached.',
      'Verification success rate is withheld below five final verified or reopened outcomes; unverified and silent cases are excluded.',
    ],
  };
}

export function comparePeriods(current: IntelligenceIncident[], previous: IntelligenceIncident[]) {
  const currentStart = current.length ? Math.min(...current.map((item) => item.createdAt.getTime())) : 0;
  const previousStart = previous.length ? Math.min(...previous.map((item) => item.createdAt.getTime())) : 0;
  return {
    currentReports: current.length,
    previousReports: previous.length,
    reportChangePercent: previous.length ? Math.round((current.length - previous.length) / previous.length * 100) : null,
    reportChangeDescription: previous.length === 0 && current.length > 0 ? 'New activity; prior comparison period had zero reports' : null,
    categoryTrends: compareCategoryTrends(current, previous),
    currentEarliestReport: currentStart ? new Date(currentStart).toISOString() : null,
    previousEarliestReport: previousStart ? new Date(previousStart).toISOString() : null,
    currentReopened: current.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length,
    previousReopened: previous.filter((item) => item.status === 'REOPENED' || item.reopenCount > 0).length,
    currentDisputes: current.reduce((sum, item) => sum + item.disputeCount, 0),
    previousDisputes: previous.reduce((sum, item) => sum + item.disputeCount, 0),
  };
}

export function priorityForRisk(score: number): RecommendationPriority {
  return score >= 75 ? 'URGENT' : score >= 55 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';
}

export function validateIncidentCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export function statusIsOpen(status: IncidentStatus) {
  return !terminalStatuses.includes(status);
}

export function statusIsTerminal(status: IncidentStatus) {
  return terminalStatuses.includes(status);
}

export function buildResolutionTrend(
  resolutionEventDates: Date[],
  period: IntelligencePeriod,
) {
  const buckets = new Map<string, number>();
  for (const eventDate of resolutionEventDates) {
    if (eventDate < period.from || eventDate > period.to) continue;
    const bucket = monthBucket(eventDate);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

export function isValidPriority(value: string): value is RecommendationPriority {
  return ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(value);
}

export function isValidRecommendationTransition(current: string, target: string) {
  const transitions: Record<string, readonly string[]> = {
    PENDING: ['ACCEPTED', 'DISMISSED'],
    ACCEPTED: ['IN_PROGRESS', 'DISMISSED'],
    IN_PROGRESS: ['COMPLETED', 'DISMISSED'],
    DISMISSED: [],
    COMPLETED: [],
  };
  return transitions[current]?.includes(target) ?? false;
}
