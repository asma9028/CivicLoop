import { describe, expect, it } from 'vitest';
import type { IncidentCategory, IncidentStatus, Severity } from '@prisma/client';
import {
  buildRecommendations,
  buildResolutionTrend,
  calculateRiskScore,
  clusterIncidents,
  compareCategoryTrends,
  detectHotspots,
  distanceMeters,
  findRecurringIssues,
  isValidRecommendationTransition,
  summarizeIntelligence,
  validateIncidentCoordinates,
  type IntelligenceIncident,
} from './engine.js';

function incident(
  id: string,
  latitude: number,
  longitude: number,
  options: Partial<IntelligenceIncident> = {},
): IntelligenceIncident {
  return {
    id,
    title: `Issue ${id}`,
    category: 'ROAD' as IncidentCategory,
    severity: 'MEDIUM' as Severity,
    status: 'REPORTED' as IncidentStatus,
    latitude,
    longitude,
    createdAt: new Date('2026-02-01T12:00:00.000Z'),
    resolvedAt: null,
    departmentId: 'dept-roads',
    departmentName: 'Roads',
    duplicateOfIncidentId: null,
    reopenCount: 0,
    disputeCount: 0,
    verificationStatuses: [],
    verifiedCount: 0,
    ...options,
  };
}

describe('city intelligence engine', () => {
  it('validates geographic coordinates and calculates geographic distance', () => {
    expect(validateIncidentCoordinates(0, 0)).toBe(true);
    expect(validateIncidentCoordinates(91, 0)).toBe(false);
    expect(validateIncidentCoordinates(0, Number.NaN)).toBe(false);
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.001 })).toBeGreaterThan(100);
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
  });

  it('clusters nearby incidents deterministically and excludes isolated reports', () => {
    const records = [
      incident('one', 28.6139, 77.2090),
      incident('two', 28.6140, 77.2091),
      incident('three', 28.6141, 77.2092),
      incident('far', 28.7000, 77.3000),
    ];
    const clusters = clusterIncidents(records, 500, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((item) => item.id)).toEqual(expect.arrayContaining(['one', 'two', 'three']));
    expect(clusters[0].map((item) => item.id)).not.toContain('far');
    expect(clusterIncidents(records.slice(0, 2), 500, 3)).toEqual([]);
  });

  it('detects spatial recurrence while separating duplicates and distant incidents', () => {
    const records = [
      incident('first', 28.6139, 77.2090, { createdAt: new Date('2026-01-01T00:00:00Z') }),
      incident('duplicate', 28.6139, 77.2090, { duplicateOfIncidentId: 'first', createdAt: new Date('2026-01-02T00:00:00Z') }),
      incident('second', 28.6140, 77.2091, { createdAt: new Date('2026-01-05T00:00:00Z') }),
      incident('third', 28.6141, 77.2092, { createdAt: new Date('2026-01-15T00:00:00Z'), status: 'REOPENED', reopenCount: 1 }),
      incident('unrelated', 28.8000, 77.5000, { createdAt: new Date('2026-01-16T00:00:00Z') }),
    ];
    const recurring = findRecurringIssues(records, 250, 365);
    expect(recurring).toHaveLength(1);
    expect(recurring[0].independentReports).toBe(3);
    expect(recurring[0].duplicateReports).toBe(1);
    expect(recurring[0].reopenedIncidents).toBe(1);
    expect(recurring[0].averageRecurrenceDays).toBe(7);
    expect(recurring[0].departments).toEqual([{ id: 'dept-roads', name: 'Roads' }]);
  });

  it('does not let pairwise recurrence links extend a group beyond the configured time window', () => {
    const records = [
      incident('one', 28.6139, 77.2090, { createdAt: new Date('2026-01-01T00:00:00Z') }),
      incident('two', 28.6140, 77.2091, { createdAt: new Date('2026-01-20T00:00:00Z') }),
      incident('three', 28.6141, 77.2092, { createdAt: new Date('2026-02-08T00:00:00Z') }),
    ];
    expect(findRecurringIssues(records, 250, 30)).toEqual([]);
  });

  it('scores risk with documented inputs and withholds classification below minimum data', () => {
    expect(calculateRiskScore({
      incidentCount: 2,
      severityDistribution: { CRITICAL: 2 },
      repeatedIssueCount: 5,
      reopenedIncidents: 2,
      overdueIncidents: 2,
      disputedResolutions: 2,
    }).sufficientData).toBe(false);
    const elevated = calculateRiskScore({
      incidentCount: 10,
      severityDistribution: { CRITICAL: 5, HIGH: 5 },
      repeatedIssueCount: 5,
      reopenedIncidents: 4,
      overdueIncidents: 5,
      disputedResolutions: 3,
    });
    expect(elevated.score).toBeGreaterThanOrEqual(75);
    expect(elevated.level).toBe('CRITICAL');
  });

  it('explains hotspot score, recurrence and only emits supported recommendations', () => {
    const records = [
      incident('a', 28.6139, 77.2090, { severity: 'HIGH' }),
      incident('b', 28.6140, 77.2091, { severity: 'CRITICAL', createdAt: new Date('2026-02-10T12:00:00.000Z') }),
      incident('c', 28.6141, 77.2092, { status: 'REOPENED', reopenCount: 1, createdAt: new Date('2026-02-15T12:00:00.000Z') }),
      incident('d', 28.6142, 77.2093, { disputeCount: 1, createdAt: new Date('2026-02-20T12:00:00.000Z') }),
    ];
    const hotspots = detectHotspots(records, { radiusMeters: 500, minIncidents: 3 });
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0].riskExplanation).toContain('high or critical severity');
    expect(hotspots[0].riskExplanation).toContain('reopening history');
    expect(hotspots[0].riskExplanation).toContain('disputed or under review');
    expect(buildRecommendations(hotspots)).toHaveLength(1);
    expect(buildRecommendations(detectHotspots([incident('alone', 0, 0)], { minIncidents: 3 }))).toEqual([]);
  });

  it('compares periods without inventing a percentage when the baseline is zero', () => {
    const current = [incident('road', 28, 77), incident('water', 28, 77, { category: 'WATER' })];
    const previous = [incident('old', 28, 77, { category: 'WASTE' })];
    const comparison = compareCategoryTrends(current, previous);
    expect(comparison.find((item) => item.category === 'ROAD')?.changePercent).toBeNull();
    expect(comparison.find((item) => item.category === 'ROAD')?.comparison).toContain('zero reports');
    expect(comparison.find((item) => item.category === 'WASTE')?.trend).toBe('DECREASING');
  });

  it('summarizes true verified, disputed, reopened, and open metrics', () => {
    const records = [
      incident('verified', 28, 77, { status: 'RESOLVED', verifiedCount: 1 }),
      incident('reopened', 28, 77, { status: 'REOPENED', reopenCount: 1, disputeCount: 1 }),
      incident('pending', 28, 77),
    ];
    const result = summarizeIntelligence(records, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-03-01T00:00:00Z'),
    });
    expect(result.metrics.totalReported).toBe(3);
    expect(result.metrics.open).toBe(2);
    expect(result.metrics.verifiedResolutions).toBe(1);
    expect(result.metrics.disputedResolutions).toBe(1);
    expect(result.metrics.reopenedIncidents).toBe(1);
    expect(result.metrics.verificationSuccessRate).toBeNull();
  });

  it('buckets resolutions by resolvedAt within the selected inclusive date range', () => {
    const period = {
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    };
    expect(buildResolutionTrend([
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-31T23:59:59.999Z'),
      new Date('2026-04-01T00:00:00Z'),
    ], period)).toEqual([{ period: '2026-03', count: 2 }]);
    expect(buildResolutionTrend([], period)).toEqual([]);
  });

  it('constrains recommendation workflow transitions', () => {
    expect(isValidRecommendationTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(isValidRecommendationTransition('PENDING', 'IN_PROGRESS')).toBe(false);
    expect(isValidRecommendationTransition('COMPLETED', 'PENDING')).toBe(false);
  });
});
