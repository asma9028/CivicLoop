import { describe, expect, it } from 'vitest';
import { isActiveWorkloadStatus, mergeTrendRows } from './analytics.js';

describe('authority analytics periods', () => {
  it('counts resolutions in their resolved-date buckets, including buckets with no reports', () => {
    expect(mergeTrendRows(
      [{ period: new Date('2026-01-01T00:00:00Z'), count: 4 }],
      [
        { period: new Date('2026-01-01T00:00:00Z'), count: 2 },
        { period: new Date('2026-02-01T00:00:00Z'), count: 1 },
      ],
    )).toEqual([
      { period: '2026-01-01T00:00:00.000Z', reports: 4, resolved: 2 },
      { period: '2026-02-01T00:00:00.000Z', reports: 0, resolved: 1 },
    ]);
  });

  it('excludes terminal incidents from current authority workload', () => {
    expect(isActiveWorkloadStatus('IN_PROGRESS')).toBe(true);
    expect(isActiveWorkloadStatus('VERIFICATION_PENDING')).toBe(true);
    expect(isActiveWorkloadStatus('RESOLVED')).toBe(false);
    expect(isActiveWorkloadStatus('REJECTED')).toBe(false);
    expect(isActiveWorkloadStatus('DUPLICATE')).toBe(false);
  });
});
