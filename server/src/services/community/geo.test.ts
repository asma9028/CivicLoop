import { describe, expect, it } from 'vitest';
import { areaBounds, distanceMeters, isValidCoordinate } from './geo.js';

describe('community geographic areas', () => {
  it('validates coordinates and calculates approximate distance', () => {
    expect(isValidCoordinate(0, 0)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.001 })).toBeGreaterThan(100);
  });

  it('creates longitude bounds that wrap at the international date line', () => {
    expect(areaBounds(0, 179.99, 5_000).longitudeRanges).toHaveLength(2);
    expect(areaBounds(0, -179.99, 5_000).longitudeRanges).toHaveLength(2);
    expect(areaBounds(0, 0, 500).longitudeRanges).toHaveLength(1);
  });
});
