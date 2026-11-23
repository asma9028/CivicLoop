import { describe, expect, it } from 'vitest';
import { campaignSnapshotWhere, getCampaignAuditAction, isCampaignJoinable, isValidCampaignTransition } from './campaigns.js';

describe('civic campaign workflow', () => {
  it('allows only documented campaign state transitions', () => {
    expect(isValidCampaignTransition('DRAFT', 'ACTIVE')).toBe(true);
    expect(isValidCampaignTransition('ACTIVE', 'PAUSED')).toBe(true);
    expect(isValidCampaignTransition('PAUSED', 'ACTIVE')).toBe(true);
    expect(isValidCampaignTransition('COMPLETED', 'ACTIVE')).toBe(false);
    expect(isValidCampaignTransition('CANCELLED', 'DRAFT')).toBe(false);
  });

  it('records publish and resume as distinct audit actions', () => {
    expect(getCampaignAuditAction('DRAFT', 'ACTIVE')).toBe('PUBLISHED');
    expect(getCampaignAuditAction('PAUSED', 'ACTIVE')).toBe('RESUMED');
  });

  it('guards campaign writes with the status and update timestamp that were reviewed', () => {
    const updatedAt = new Date('2026-03-10T12:00:00Z');
    expect(campaignSnapshotWhere({ id: 'campaign-1', status: 'ACTIVE', updatedAt })).toEqual({
      id: 'campaign-1',
      status: 'ACTIVE',
      updatedAt,
    });
  });

  it('accepts participation only during an active campaign date range', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const window = { startAt: new Date('2026-03-01T00:00:00Z'), endAt: new Date('2026-03-31T23:59:59Z') };
    expect(isCampaignJoinable({ ...window, status: 'ACTIVE' }, now)).toBe(true);
    expect(isCampaignJoinable({ ...window, status: 'PAUSED' }, now)).toBe(false);
    expect(isCampaignJoinable({ ...window, status: 'ACTIVE', startAt: new Date('2026-03-11T00:00:00Z') }, now)).toBe(false);
    expect(isCampaignJoinable({ ...window, status: 'ACTIVE', endAt: new Date('2026-03-01T00:00:00Z') }, now)).toBe(false);
  });
});
