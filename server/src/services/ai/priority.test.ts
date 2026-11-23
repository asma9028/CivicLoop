import { describe, expect, it } from 'vitest';
import { calculatePriority } from './priority.js';

describe('priority scoring', () => {
  it('is deterministic and normalized to 0..100', () => {
    const input = { severity: 'CRITICAL' as const, safetyRisk: 100, publicImpact: 90, timeSensitivity: 100, confidence: 90 };
    const first = calculatePriority(input);
    expect(first).toEqual(calculatePriority(input));
    expect(first.score).toBeGreaterThanOrEqual(0);
    expect(first.score).toBeLessThanOrEqual(100);
    expect(first.band).toBe('P1');
  });

  it('clamps invalid scoring inputs and produces lower priority for low impact', () => {
    const result = calculatePriority({ severity: 'LOW', safetyRisk: -20, publicImpact: 0, timeSensitivity: 0, confidence: 0 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.band).toBe('P4');
  });
});
