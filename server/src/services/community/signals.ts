export type CollectiveSignalLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'STRONG';

export interface CollectiveSignalInput {
  supportCount: number;
  recurrenceCount: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  ageDays: number;
  reopenCount: number;
  disputedResolutionCount: number;
}

export interface CollectiveSignal {
  score: number;
  level: CollectiveSignalLevel;
  components: {
    communitySupport: number;
    recurrence: number;
    severity: number;
    timeOpen: number;
    reopenHistory: number;
    disputedResolution: number;
  };
}

const nonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

export function calculateCollectiveSignal(input: CollectiveSignalInput): CollectiveSignal {
  const supportCount = nonNegative(input.supportCount);
  const recurrenceCount = nonNegative(input.recurrenceCount);
  const ageDays = nonNegative(input.ageDays);
  const reopenCount = nonNegative(input.reopenCount);
  const disputedResolutionCount = nonNegative(input.disputedResolutionCount);
  const severityPoints: Record<CollectiveSignalInput['severity'], number> = {
    LOW: 3.75,
    MEDIUM: 7.5,
    HIGH: 11.25,
    CRITICAL: 15,
  };
  const rawComponents = {
    communitySupport: Math.min(supportCount / 20, 1) * 40,
    recurrence: Math.min(recurrenceCount / 4, 1) * 20,
    severity: severityPoints[input.severity],
    timeOpen: Math.min(ageDays / 30, 1) * 10,
    reopenHistory: Math.min(reopenCount / 2, 1) * 10,
    disputedResolution: Math.min(disputedResolutionCount / 2, 1) * 5,
  };
  const score = Math.round(Object.values(rawComponents).reduce((sum, component) => sum + component, 0));
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    score,
    level: score >= 75 ? 'STRONG' : score >= 50 ? 'HIGH' : score >= 25 ? 'MODERATE' : 'LOW',
    components: {
      communitySupport: round(rawComponents.communitySupport),
      recurrence: round(rawComponents.recurrence),
      severity: round(rawComponents.severity),
      timeOpen: round(rawComponents.timeOpen),
      reopenHistory: round(rawComponents.reopenHistory),
      disputedResolution: round(rawComponents.disputedResolution),
    },
  };
}
