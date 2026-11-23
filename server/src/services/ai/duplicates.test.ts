import { beforeEach, describe, expect, it, vi } from 'vitest';

const { incidentFindMany } = vi.hoisted(() => ({ incidentFindMany: vi.fn() }));
vi.mock('../../config/prisma.js', () => ({ prisma: { incident: { findMany: incidentFindMany } } }));

import { findPotentialDuplicates, geographicDistanceMeters, textSimilarity } from './duplicates.js';

describe('duplicate detection primitives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scores matching civic descriptions higher than unrelated descriptions', () => {
    const matching = textSimilarity('Deep pothole on Central Avenue near bus stop', 'Large pothole on Central Avenue by bus stop');
    const unrelated = textSimilarity('Overflowing garbage collection bin', 'Broken streetlight near park');
    expect(matching).toBeGreaterThan(unrelated);
    expect(matching).toBeGreaterThan(0.2);
  });

  it('calculates geographical distance in metres', () => {
    expect(geographicDistanceMeters(28.6139, 77.209, 28.6139, 77.209)).toBe(0);
    expect(geographicDistanceMeters(28.6139, 77.209, 28.6149, 77.209)).toBeGreaterThan(100);
  });

  it('sanitizes public text and hides exact address details in duplicate results', async () => {
    incidentFindMany.mockResolvedValue([{
      id: 'public-incident-1',
      category: 'ROAD',
      title: 'Pothole near 44 Cedar Avenue',
      description: 'Pothole blocks the road. Email citizen@example.com; Aadhaar 1234 5678 9012.',
      status: 'REPORTED',
      locationText: '44 Cedar Avenue, contact +1 (555) 234-5678',
      createdAt: new Date(),
      latitude: 28.6139,
      longitude: 77.209,
    }]);

    const results = await findPotentialDuplicates({
      title: 'Pothole road issue',
      description: 'A pothole blocks the road and is a danger for traffic.',
      category: 'ROAD',
      locationText: 'Cedar Avenue',
      latitude: 28.6139,
      longitude: 77.209,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).not.toContain('44 Cedar Avenue');
    expect(results[0]?.description).not.toContain('citizen@example.com');
    expect(results[0]?.description).not.toContain('1234 5678 9012');
    expect(results[0]?.locationText).toBe('Approximate area');
    expect(results[0]?.distanceLabel).toBe('Nearby');
    expect(results[0]?.distanceMeters).toBeNull();
  });

  it('does not disclose precise coordinates through distance scores within the same public coordinate cell', async () => {
    const publicIncident = {
      id: 'public-incident-1',
      category: 'ROAD',
      title: 'Pothole on Central Road',
      description: 'A pothole blocks the road and risks traffic.',
      status: 'REPORTED',
      locationText: 'Central Road',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      latitude: 28.611,
      longitude: 77.209,
    };
    const input = {
      title: 'Pothole road issue',
      description: 'A pothole blocks the road and is a danger for traffic.',
      category: 'ROAD' as const,
      latitude: 28.6139,
      longitude: 77.209,
    };
    incidentFindMany.mockResolvedValueOnce([publicIncident]).mockResolvedValueOnce([{
      ...publicIncident,
      latitude: 28.614,
      longitude: 77.206,
    }]);

    const first = await findPotentialDuplicates(input);
    const second = await findPotentialDuplicates(input);

    expect(second).toEqual(first);
  });
});
