import type { IncidentStatus } from '@prisma/client';

const terminalStatuses: IncidentStatus[] = ['RESOLVED', 'REJECTED', 'DUPLICATE'];

export function isActiveWorkloadStatus(status: IncidentStatus) {
  return !terminalStatuses.includes(status);
}

export function mergeTrendRows(
  reportRows: Array<{ period: Date; count: number }>,
  resolutionRows: Array<{ period: Date; count: number }>,
) {
  const counts = new Map<number, { period: Date; reports: number; resolved: number }>();
  for (const row of reportRows) {
    counts.set(row.period.getTime(), { period: row.period, reports: row.count, resolved: 0 });
  }
  for (const row of resolutionRows) {
    const key = row.period.getTime();
    const bucket = counts.get(key) ?? { period: row.period, reports: 0, resolved: 0 };
    bucket.resolved = row.count;
    counts.set(key, bucket);
  }
  return [...counts.values()]
    .sort((a, b) => a.period.getTime() - b.period.getTime())
    .map((row) => ({ period: row.period.toISOString(), reports: row.reports, resolved: row.resolved }));
}
