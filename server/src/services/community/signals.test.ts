import { describe, expect, it } from 'vitest';
import { calculateCollectiveSignal } from './signals.js';

describe('collective signal', () => {
  it('keeps community support separate and bounded below the full score', () => {
    const popularLowSeverity = calculateCollectiveSignal({
      supportCount: 20,
      recurrenceCount: 0,
      severity: 'LOW',
      ageDays: 0,
      reopenCount: 0,
      disputedResolutionCount: 0,
    });
    expect(popularLowSeverity.components.communitySupport).toBe(40);
    expect(popularLowSeverity.score).toBe(44);
    expect(popularLowSeverity.level).toBe('MODERATE');
  });

  it('includes recurrence, age, reopen and dispute evidence without exceeding 100', () => {
    const signal = calculateCollectiveSignal({
      supportCount: 40,
      recurrenceCount: 8,
      severity: 'CRITICAL',
      ageDays: 60,
      reopenCount: 4,
      disputedResolutionCount: 4,
    });
    expect(signal.score).toBe(100);
    expect(signal.level).toBe('STRONG');
    expect(Object.values(signal.components).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('treats invalid and negative counts as zero', () => {
    const signal = calculateCollectiveSignal({
      supportCount: -1,
      recurrenceCount: Number.NaN,
      severity: 'LOW',
      ageDays: -10,
      reopenCount: -1,
      disputedResolutionCount: -1,
    });
    expect(signal.components.communitySupport).toBe(0);
    expect(signal.components.recurrence).toBe(0);
    expect(signal.score).toBe(4);
  });
});
