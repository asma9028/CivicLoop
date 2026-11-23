import { describe, expect, it } from 'vitest';
import { incidents } from './incidents';

describe('synthetic incident dataset', () => {
  it('contains 20 clearly identifiable demo incidents', () => {
    expect(incidents).toHaveLength(20);
    expect(new Set(incidents.map((incident) => incident.id)).size).toBe(20);
  });

  it('contains every supported incident category', () => {
    expect(new Set(incidents.map((incident) => incident.category))).toEqual(
      new Set(['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER']),
    );
  });
});
