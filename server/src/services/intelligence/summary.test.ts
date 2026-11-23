import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeCityIntelligence, validateCityIntelligenceNarrative } from './summary.js';

afterEach(() => vi.unstubAllEnvs());

describe('aggregated city narrative', () => {
  it('validates the structured output schema', () => {
    const value = {
      citySummary: 'Report volume changed during the selected period, based on the data available.',
      emergingPatterns: ['Road reports are more common in the current comparison period.'],
      areasRequiringAttention: ['The clustered area has several overdue reports.'],
      recommendedActions: ['Inspect the reported drainage area before the next maintenance cycle.'],
      dataLimitations: ['No incident records are available in the prior comparison period.'],
    };
    expect(validateCityIntelligenceNarrative(value)).toEqual(value);
    expect(validateCityIntelligenceNarrative({ ...value, unsupportedPrediction: 'The area will flood.' })).toBeNull();
    expect(validateCityIntelligenceNarrative({ ...value, emergingPatterns: [''] })).toBeNull();
  });

  it('uses a visible unavailable fallback when Gemini is not configured', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const result = await summarizeCityIntelligence({
      period: { from: '2026-01-01', to: '2026-01-31' },
      metrics: { totalReported: 0 },
      byCategory: {},
      bySeverity: {},
      byStatus: {},
      comparisons: {},
      hotspots: [],
      recurrences: [],
      dataLimitations: [],
    });
    expect(result.provider).toBe('unavailable');
    expect(result.narrative.citySummary).toContain('AI summary is unavailable');
  });
});
