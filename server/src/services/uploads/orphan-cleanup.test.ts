import { describe, expect, it } from 'vitest';
import { selectExpiredOrphanUploads } from './orphan-cleanup.js';

describe('orphan upload cleanup eligibility', () => {
  it('only selects old, unlinked, unreferenced upload files', () => {
    const cutoff = new Date('2026-02-20T00:00:00Z');
    const candidates = [
      { id: 'expired', storedName: 'a0000000-0000-4000-8000-000000000001.jpg', createdAt: new Date('2026-02-01T00:00:00Z'), incidentId: null },
      { id: 'recent', storedName: 'a0000000-0000-4000-8000-000000000002.png', createdAt: new Date('2026-02-28T00:00:00Z'), incidentId: null },
      { id: 'linked', storedName: 'a0000000-0000-4000-8000-000000000003.webp', createdAt: new Date('2026-01-01T00:00:00Z'), incidentId: 'incident-1' },
      { id: 'referenced', storedName: 'a0000000-0000-4000-8000-000000000004.jpg', createdAt: new Date('2026-01-01T00:00:00Z'), incidentId: null },
      { id: 'invalid-name', storedName: '..\\outside.jpg', createdAt: new Date('2026-01-01T00:00:00Z'), incidentId: null },
    ];

    expect(selectExpiredOrphanUploads(
      candidates,
      new Set(['a0000000-0000-4000-8000-000000000004.jpg']),
      cutoff,
    ).map((upload) => upload.id))
      .toEqual(['expired']);
  });
});
