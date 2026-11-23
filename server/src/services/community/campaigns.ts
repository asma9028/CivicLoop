import type { CivicCampaignStatus } from '@prisma/client';

const campaignTransitions: Record<CivicCampaignStatus, CivicCampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function isValidCampaignTransition(current: CivicCampaignStatus, next: CivicCampaignStatus) {
  return campaignTransitions[current].includes(next);
}

export class CampaignChangedError extends Error {
  constructor() {
    super('Campaign changed while this update was being saved');
    this.name = 'CampaignChangedError';
  }
}

export function campaignSnapshotWhere(campaign: { id: string; status: CivicCampaignStatus; updatedAt: Date }) {
  return { id: campaign.id, status: campaign.status, updatedAt: campaign.updatedAt };
}

export function isCampaignJoinable(
  campaign: { status: CivicCampaignStatus; startAt: Date; endAt: Date },
  now = new Date(),
) {
  return campaign.status === 'ACTIVE' && campaign.startAt <= now && campaign.endAt >= now;
}

export function getCampaignAuditAction(current: CivicCampaignStatus, next: CivicCampaignStatus) {
  if (next === 'ACTIVE') return current === 'PAUSED' ? 'RESUMED' as const : 'PUBLISHED' as const;
  if (next === 'PAUSED') return 'PAUSED' as const;
  if (next === 'COMPLETED') return 'COMPLETED' as const;
  if (next === 'CANCELLED') return 'CANCELLED' as const;
  return 'UPDATED' as const;
}
